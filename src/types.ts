import { Program, Type, Stmt, Expr, Pos } from "./ast";

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
  | { kind: "alias"; mode: "unrestricted"; name: string; members: string[] } // member names are unresolved — look up via ResolveEnv.aliases
  | { kind: "enum"; mode: "linear" | "unrestricted"; name: string };

export type EnumInfo = { name: string; isLinear: boolean };

export type VariantInfo = { enumName: string; payload: FitType | null };

// name is redundant with the Map key in TypeEnv — kept so these types are self-contained
// when passed around without their Map context.
export type ResourceInfo = {
  name: string;
  typeParam: string | null;
  cleanup: string;
  fallback: boolean;
};
export type ResolvedParam = { name: string; type_: FitType; mode: ParamMode };
export type FunctionSig = {
  name: string;
  params: ResolvedParam[];
  caps: string[];
  returnType: FitType;
};

export type TypeEnv = {
  resources: Map<string, ResourceInfo>;
  aliases: Map<string, string[]>;
  enums: Map<string, VariantInfo>;       // keyed by variant name (e.g. "More", "Done")
  enumDecls: Map<string, EnumInfo>;      // keyed by enum name
  functions: Map<string, FunctionSig>;
};
// ResolveEnv is the subset of TypeEnv that resolveType needs during the enum loop.
// Using Pick here prevents resolveType from accidentally reading a partially-built
// functions map during buildTypeEnv's two-pass construction.
export type ResolveEnv = Pick<TypeEnv, "resources" | "aliases">;
// WideResolveEnv extends ResolveEnv with enumDecls — used after the enum loop so that
// enum names in function param/return types resolve to { kind: "enum" } instead of plain.
export type WideResolveEnv = Pick<TypeEnv, "resources" | "aliases" | "enumDecls">;

// Errors emitted during type-environment construction (e.g. missing annotation on
// extern linear param). Structurally identical to CheckError in checker.ts so they
// can be merged into the same error array without a shared import.
export type BuildError = { message: string; pos: Pos };

// Recursion depth is bounded by the nesting depth of the Type AST.
// Pathologically deep types (e.g. 10k-nested Result) can overflow the JS call stack.
// For the PoC this is acceptable — all source files are trusted.
export function resolveType(ast: Type, env: ResolveEnv | WideResolveEnv): FitType {
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
      if ("enumDecls" in env) {
        const enumDecl = env.enumDecls.get(ast.name);
        if (enumDecl) {
          return {
            kind: "enum",
            mode: enumDecl.isLinear ? "linear" : "unrestricted",
            name: ast.name,
          };
        }
      }
      return { kind: "plain", mode: "unrestricted", name: ast.name };
    }
    default: {
      const _exhaustive: never = ast;
      throw new Error(`resolveType: unhandled Type kind`);
    }
  }
}

// Known body-inference gaps: store-into-aggregate (`pool_add(pool, c)`) is undetected
// unless pool_add's param is already marked move. Self-recursive functions must use an
// explicit annotation — body-scan sees the recursive call with placeholder lend.

function exprConsumesVar(
  name: string,
  expr: Expr,
  fnMap: Map<string, FunctionSig>
): boolean {
  switch (expr.kind) {
    case "var":
      return false;
    case "call": {
      if (expr.fn === "drop") {
        return expr.args.some((a) => a.kind === "var" && a.name === name);
      }
      const sig = fnMap.get(expr.fn);
      if (!sig) return false;
      for (let i = 0; i < sig.params.length && i < expr.args.length; i++) {
        const arg = expr.args[i];
        if (sig.params[i].mode === "move" && arg.kind === "var" && arg.name === name) {
          return true;
        }
      }
      return false;
    }
    case "ok":
    case "err":
      // Ok(name) / Err(name) — wrapping the resource transfers ownership
      if (expr.expr.kind === "var" && expr.expr.name === name) return true;
      return exprConsumesVar(name, expr.expr, fnMap);
    case "try":
      return exprConsumesVar(name, expr.expr, fnMap);
    case "unit_val":
      return false;
    default: {
      const _exhaustive: never = expr;
      return false;
    }
  }
}

function stmtConsumesVar(
  name: string,
  stmt: Stmt,
  fnMap: Map<string, FunctionSig>
): boolean {
  switch (stmt.kind) {
    case "expr":
      return exprConsumesVar(name, stmt.expr, fnMap);
    case "let":
      return exprConsumesVar(name, stmt.init, fnMap);
    case "rebind":
      return exprConsumesVar(name, stmt.expr, fnMap);
    case "if":
      return (
        bodyConsumesVar(name, stmt.then, fnMap) ||
        bodyConsumesVar(name, stmt.else_, fnMap)
      );
    case "loop":
      return bodyConsumesVar(name, stmt.body, fnMap);
    case "match":
      return stmt.arms.some((arm) => bodyConsumesVar(name, arm.body, fnMap));
    case "break":
    case "select":
      return false;
    default: {
      const _exhaustive: never = stmt;
      return false;
    }
  }
}

function bodyConsumesVar(
  name: string,
  stmts: Stmt[],
  fnMap: Map<string, FunctionSig>
): boolean {
  return stmts.some((s) => stmtConsumesVar(name, s, fnMap));
}

function inferParamModeFromBody(
  paramName: string,
  body: Stmt[],
  fnMap: Map<string, FunctionSig>
): ParamMode {
  return bodyConsumesVar(paramName, body, fnMap) ? "move" : "lend";
}

export function buildTypeEnv(program: Program): { env: TypeEnv; buildErrors: BuildError[] } {
  const resources = new Map<string, ResourceInfo>();
  const aliases = new Map<string, string[]>();
  const enums = new Map<string, VariantInfo>();
  const enumDecls = new Map<string, EnumInfo>();
  const functions = new Map<string, FunctionSig>();
  const buildErrors: BuildError[] = [];

  // Pass 1a: resources and aliases.
  // Duplicate decl names silently last-write-win — unchanged from original behaviour.
  for (const decl of program.decls) {
    if (decl.kind === "resource") {
      resources.set(decl.name, {
        name: decl.name,
        typeParam: decl.typeParam,
        cleanup: decl.cleanup.fn,
        fallback: decl.cleanup.fallback,
      });
    } else if (decl.kind === "type_alias") {
      aliases.set(decl.name, [...decl.members]); // defensive copy
    }
    // capability and record decls are ignored; enums are handled in the dedicated loop below.
  }

  // Two-pass boundary: resolveEnv excludes functions so resolveType cannot access the
  // partially-built functions map. Do NOT merge the passes.
  const resolveEnv: ResolveEnv = { resources, aliases };

  // Enum resolution — payloads may reference resources, so this must follow resolveEnv construction.
  // Uses narrow resolveEnv (payloads cannot circularly reference their own enum's linear flag).
  // Also populates enumDecls: an enum is linear iff any non-colliding variant has a linear payload.
  for (const decl of program.decls) {
    if (decl.kind === "enum") {
      let isLinear = false;
      for (const variant of decl.variants) {
        if (enums.has(variant.name)) {
          buildErrors.push({
            message: `variant name '${variant.name}' is already declared by enum '${enums.get(variant.name)!.enumName}'`,
            pos: decl.pos,
          });
        } else {
          const payload = variant.payload !== null ? resolveType(variant.payload, resolveEnv) : null;
          enums.set(variant.name, { enumName: decl.name, payload });
          if (payload !== null && payload.mode === "linear") isLinear = true;
        }
      }
      enumDecls.set(decl.name, { name: decl.name, isLinear });
    }
  }

  // Wide resolve env: includes enumDecls so function param/return types named after enums
  // resolve to { kind: "enum" } rather than plain. Used from here on.
  const wideResolveEnv: WideResolveEnv = { resources, aliases, enumDecls };

  // Pass 1b: build all function signatures.
  // Externs (no body): use explicit annotation; emit BuildError for unannotated linear params.
  // Bodied functions: use explicit annotation if present; otherwise placeholder lend
  //   (pass-2 will re-infer by body inspection).
  // Uses wideResolveEnv so enum names in return/param types resolve to { kind: "enum" }.
  for (const decl of program.decls) {
    if (decl.kind === "fn") {
      const returnType = resolveType(decl.returnType, wideResolveEnv);
      const params: ResolvedParam[] = decl.params.map((p) => {
        const type_ = resolveType(p.type_, wideResolveEnv);
        let mode: ParamMode;
        if (type_.kind === "resource") {
          if (p.annotatedMode !== null) {
            // Explicit annotation — used for both externs and bodied functions.
            mode = p.annotatedMode;
          } else if (decl.body === null) {
            // Extern with a linear param and no annotation. Per spec §4 (amended):
            // this is a compile error. Conservative lend fallback keeps type-checking going.
            buildErrors.push({
              message: `extern '${decl.name}' has linear parameter '${p.name}' with no move/lend annotation`,
              pos: decl.pos,
            });
            mode = "lend";
          } else {
            // Bodied function, no annotation — placeholder lend for pass-2 re-inference.
            mode = "lend";
          }
        } else {
          // Non-linear param: move/lend distinction is meaningless (nothing to consume).
          // Annotation is accepted if present but not required. Always effectively lend.
          mode = "lend";
        }
        return { name: p.name, type_, mode };
      });
      functions.set(decl.name, {
        name: decl.name,
        params,
        caps: [...decl.caps], // defensive copy
        returnType,
      });
    }
  }

  // Pass 2: re-infer modes for bodied functions whose resource params lack explicit annotation.
  // Processes declarations in source order — correct for DAG call graphs (callee appears before
  // caller, or caller has explicit annotation). Self-recursive and mutually-recursive functions
  // require explicit annotations (single-pass, no fixed-point iteration in PoC).
  for (const decl of program.decls) {
    if (decl.kind === "fn" && decl.body !== null) {
      const sig = functions.get(decl.name)!;
      for (let i = 0; i < sig.params.length; i++) {
        const param = sig.params[i];
        const astParam = decl.params[i];
        if (param.type_.kind === "resource" && astParam.annotatedMode === null) {
          // No explicit annotation: infer from body using current function map.
          // Callee modes are already settled (externs from pass-1b; earlier bodied
          // functions updated in-place by prior iterations of this loop).
          param.mode = inferParamModeFromBody(param.name, decl.body, functions);
        }
        // If annotated: mode was set in pass-1b — leave it.
      }
    }
  }

  return { env: { resources, aliases, enums, enumDecls, functions }, buildErrors };
}
