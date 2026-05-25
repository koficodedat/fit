import { Program, Type } from "./ast";

export type MemoryMode = "unrestricted" | "linear";
export type ParamMode  = "lend" | "move";

// mode is derivable from kind (resource → linear, all others → unrestricted).
// Kept for spec-terminology alignment — use t.mode === "linear" in checker code.
// Do not add a separate isLinear() helper.
export type FitType =
  | { kind: "plain";    mode: "unrestricted"; name: string }
  | { kind: "resource"; mode: "linear";       name: string; typeState: string | null; cleanup: string; fallback: boolean }
  | { kind: "result";   mode: "unrestricted"; ok: FitType; err: FitType }
  | { kind: "unit";     mode: "unrestricted" }
  | { kind: "alias";    mode: "unrestricted"; name: string; members: string[] }; // member names are unresolved — look up via ResolveEnv.aliases

// name is redundant with the Map key in TypeEnv — kept so these types are self-contained
// when passed around without their Map context.
export type ResourceInfo  = { name: string; typeParam: string | null; cleanup: string; fallback: boolean };
export type ResolvedParam = { name: string; type_: FitType; mode: ParamMode };
export type FunctionSig   = { name: string; params: ResolvedParam[]; caps: string[]; returnType: FitType };

export type TypeEnv    = { resources: Map<string, ResourceInfo>; aliases: Map<string, string[]>; functions: Map<string, FunctionSig> };
// ResolveEnv is the subset of TypeEnv that resolveType needs.
// Using Pick here prevents resolveType from accidentally reading a partially-built
// functions map during buildTypeEnv's two-pass construction.
export type ResolveEnv = Pick<TypeEnv, "resources" | "aliases">;

export function resolveType(ast: Type, env: ResolveEnv): FitType {
  switch (ast.kind) {
    case "unit":
      return { kind: "unit", mode: "unrestricted" };
    case "result": {
      const ok  = resolveType(ast.ok,  env);
      const err = resolveType(ast.err, env);
      return { kind: "result", mode: "unrestricted", ok, err };
    }
    case "named": {
      const resource = env.resources.get(ast.name);
      if (resource) {
        // typeArg?.kind === "named" relies on parser invariant: typestate args are always identifiers.
        const typeState = ast.typeArg?.kind === "named" ? ast.typeArg.name : null;
        return { kind: "resource", mode: "linear", name: ast.name, typeState, cleanup: resource.cleanup, fallback: resource.fallback };
      }
      const alias = env.aliases.get(ast.name);
      if (alias) {
        return { kind: "alias", mode: "unrestricted", name: ast.name, members: alias };
      }
      return { kind: "plain", mode: "unrestricted", name: ast.name };
    }
  }
}

// Does not expand aliases: "SessionError" would not match its member names ("SmtpError").
// In FIT, type aliases are error unions only — resource aliasing doesn't arise in the PoC,
// so alias non-expansion is an accepted limitation of the heuristic.
function typeContainsName(t: Type, name: string): boolean {
  switch (t.kind) {
    case "unit":   return false;
    case "named":  return t.name === name || (t.typeArg !== null && typeContainsName(t.typeArg, name));
    case "result": return typeContainsName(t.ok, name) || typeContainsName(t.err, name);
  }
}

export function inferParamMode(paramBaseName: string, returnType: Type): ParamMode {
  return typeContainsName(returnType, paramBaseName) ? "move" : "lend";
}

export function buildTypeEnv(_program: Program): TypeEnv {
  throw new Error("not implemented");
}
