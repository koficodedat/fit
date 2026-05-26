export type Pos = { line: number; col: number };

export type Program = { decls: Decl[] };

export type Decl =
  | { kind: "capability"; name: string; pos: Pos }
  | { kind: "record"; name: string; fields: FieldDef[]; pos: Pos }
  | { kind: "enum"; name: string; variants: VariantDef[]; pos: Pos }
  | {
      kind: "resource";
      name: string;
      typeParam: string | null;
      fields: FieldDef[];
      cleanup: CleanupDef;
      pos: Pos;
    }
  | { kind: "type_alias"; name: string; members: string[]; pos: Pos }
  | {
      kind: "fn";
      name: string;
      params: ParamDef[];
      caps: string[];
      returnType: Type;
      body: Stmt[] | null;
      pos: Pos;
    };

export type Type =
  | { kind: "named"; name: string; typeArg: Type | null }
  | { kind: "result"; ok: Type; err: Type }
  | { kind: "unit" };

export type Stmt =
  | { kind: "let"; name: string; mut: boolean; init: Expr; pos: Pos }
  | { kind: "rebind"; name: string; expr: Expr; pos: Pos }
  | { kind: "expr"; expr: Expr; pos: Pos }
  | { kind: "if"; cond: Expr; then: Stmt[]; else_: Stmt[]; pos: Pos }
  | { kind: "loop"; body: Stmt[]; pos: Pos }
  | { kind: "match"; expr: Expr; arms: MatchArm[]; pos: Pos }
  | { kind: "break"; pos: Pos }
  | { kind: "select"; atoms: string[]; from: string; pos: Pos };

export type Expr =
  | { kind: "var"; name: string; pos: Pos }
  | { kind: "call"; fn: string; args: Expr[]; pos: Pos }
  | { kind: "try"; expr: Expr; pos: Pos }
  | { kind: "ok"; expr: Expr; pos: Pos }
  | { kind: "err"; expr: Expr; pos: Pos }
  | { kind: "unit_val"; pos: Pos };

export type FieldDef = { name: string; type_: Type };
export type ParamDef = { name: string; type_: Type; annotatedMode: "move" | "lend" | null };
export type CleanupDef = { fallback: boolean; fn: string };
export type VariantDef = { name: string; payload: Type | null };
export type MatchArm = { pattern: Pattern; body: Stmt[] };
export type Pattern = { kind: "variant"; name: string; binds: string[] } | { kind: "wildcard" };
