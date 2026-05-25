import { Program, Type } from "./ast";

export type MemoryMode = "unrestricted" | "linear";
export type ParamMode = "lend" | "move";

// mode is derivable from kind (resource → linear, all others → unrestricted).
// Kept for spec-terminology alignment — use t.mode === "linear" in checker code.
// Do not add a separate isLinear() helper.
export type FitType =
  | { kind: "plain"; mode: "unrestricted"; name: string }
  | {
      kind: "resource";
      mode: "linear";
      name: string;
      typeState: string | null;
      cleanup: string;
      fallback: boolean;
    }
  | { kind: "result"; mode: "unrestricted"; ok: FitType; err: FitType }
  | { kind: "unit"; mode: "unrestricted" }
  | { kind: "alias"; mode: "unrestricted"; name: string; members: string[] }; // member names are unresolved — look up via ResolveEnv.aliases

// name is redundant with the Map key in TypeEnv — kept so these types are self-contained
// when passed around without their Map context.
export type ResourceInfo = {
  name: string;
  typeParam: string | null;
  cleanup: string;
  fallback: boolean;
};
export type ResolvedParam = { name: string; type_: FitType; mode: ParamMode };
// name is redundant with the Map key in TypeEnv — kept so FunctionSig is self-contained when passed without its Map context.
export type FunctionSig = {
  name: string;
  params: ResolvedParam[];
  caps: string[];
  returnType: FitType;
};

export type TypeEnv = {
  resources: Map<string, ResourceInfo>;
  aliases: Map<string, string[]>;
  functions: Map<string, FunctionSig>;
};
// ResolveEnv is the subset of TypeEnv that resolveType needs.
// Using Pick here prevents resolveType from accidentally reading a partially-built
// functions map during buildTypeEnv's two-pass construction.
export type ResolveEnv = Pick<TypeEnv, "resources" | "aliases">;

// Recursion depth is bounded by the nesting depth of the Type AST.
// Pathologically deep types (e.g. 10k-nested Result) can overflow the JS call stack.
// For the PoC this is acceptable — all source files are trusted.
export function resolveType(ast: Type, env: ResolveEnv): FitType {
  switch (ast.kind) {
    case "unit":
      return { kind: "unit", mode: "unrestricted" };
    case "result": {
      const ok = resolveType(ast.ok, env);
      const err = resolveType(ast.err, env);
      return { kind: "result", mode: "unrestricted", ok, err };
    }
    case "named": {
      const resource = env.resources.get(ast.name);
      if (resource) {
        if (ast.typeArg !== null && ast.typeArg.kind !== "named") {
          throw new Error(
            `resolveType: typeArg for resource '${ast.name}' is not a named identifier — parser invariant violated`
          );
        }
        const typeState = ast.typeArg !== null ? ast.typeArg.name : null;
        // typeArg on alias/plain variants is intentionally unused — FIT syntax does not permit
        // generic aliases or parameterised plain types.
        return {
          kind: "resource",
          mode: "linear",
          name: ast.name,
          typeState,
          cleanup: resource.cleanup,
          fallback: resource.fallback,
        };
      }
      const alias = env.aliases.get(ast.name);
      if (alias) {
        return { kind: "alias", mode: "unrestricted", name: ast.name, members: alias };
      }
      return { kind: "plain", mode: "unrestricted", name: ast.name };
    }
    default: {
      const _exhaustive: never = ast;
      throw new Error(`resolveType: unhandled Type kind`);
    }
  }
}

// Does not expand aliases: "SessionError" would not match its member names ("SmtpError").
// In FIT, type aliases are error unions only — resource aliasing doesn't arise in the PoC,
// so alias non-expansion is an accepted limitation of the heuristic.
function typeContainsName(t: Type, name: string): boolean {
  switch (t.kind) {
    case "unit":
      return false;
    case "named":
      return t.name === name || (t.typeArg !== null && typeContainsName(t.typeArg, name));
    case "result":
      return typeContainsName(t.ok, name) || typeContainsName(t.err, name);
    default: {
      const _exhaustive: never = t;
      return false;
    }
  }
}

// paramBaseName="" is a sentinel meaning "no base name" — produced by buildTypeEnv for
// non-named params (unit or result types). Empty string never matches any type name,
// so it always infers "lend". This is correct: non-named params are never linear resources.
export function inferParamMode(paramBaseName: string, returnType: Type): ParamMode {
  return typeContainsName(returnType, paramBaseName) ? "move" : "lend";
}

export function buildTypeEnv(program: Program): TypeEnv {
  const resources = new Map<string, ResourceInfo>();
  const aliases = new Map<string, string[]>();
  const functions = new Map<string, FunctionSig>();

  // Duplicate decl names silently last-write-win — the parser does not enforce
  // name uniqueness and buildTypeEnv does not either. Step 3 (checker) is
  // responsible for catching duplicate declarations if needed.
  for (const decl of program.decls) {
    if (decl.kind === "resource") {
      resources.set(decl.name, {
        name: decl.name,
        typeParam: decl.typeParam,
        cleanup: decl.cleanup.fn,
        fallback: decl.cleanup.fallback,
      });
    } else if (decl.kind === "type_alias") {
      aliases.set(decl.name, [...decl.members]); // defensive copy — callers must not mutate alias member arrays.
    }
    // capability, record, enum decls are intentionally ignored in pass 1.
  }

  // Two-pass boundary: resolveEnv excludes functions so resolveType cannot access the
  // partially-built functions map. Do NOT merge the passes — that would break this invariant.
  const resolveEnv: ResolveEnv = { resources, aliases };

  for (const decl of program.decls) {
    if (decl.kind === "fn") {
      // decl.body may be null (signature-only fn). buildTypeEnv does not inspect it.
      // Step 3 must guard on decl.body === null before attempting linearity checks.
      const returnType = resolveType(decl.returnType, resolveEnv);
      const params: ResolvedParam[] = decl.params.map((p) => {
        const type_ = resolveType(p.type_, resolveEnv);
        const baseName = p.type_.kind === "named" ? p.type_.name : "";
        // decl.returnType is re-traversed once per param (no pre-indexing). Acceptable for small signatures.
        const mode = inferParamMode(baseName, decl.returnType); // raw AST: alias expansion not needed for name-matching heuristic
        return { name: p.name, type_, mode };
      });
      functions.set(decl.name, { name: decl.name, params, caps: [...decl.caps], returnType }); // defensive copy — callers must not mutate caps arrays.
    }
  }

  // Callers must null-check env.functions.get(name) — Map returns undefined on miss.
  return { resources, aliases, functions };
}
