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
  | { kind: "alias";    mode: "unrestricted"; name: string; members: string[] };

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

export function resolveType(_ast: Type, _env: ResolveEnv): FitType {
  throw new Error("not implemented");
}

export function inferParamMode(_paramBaseName: string, _returnType: Type): ParamMode {
  throw new Error("not implemented");
}

export function buildTypeEnv(_program: Program): TypeEnv {
  throw new Error("not implemented");
}
