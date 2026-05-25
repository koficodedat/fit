import { Program, Stmt, Expr, Pos } from "./ast";
import { FitType, TypeEnv, buildTypeEnv } from "./types";

export type CheckError = { message: string; pos: Pos };

type Binding = { type_: FitType; owned: boolean; moved: boolean };
type Scope = Map<string, Binding>;

export function check(program: Program): CheckError[] {
  const env = buildTypeEnv(program);
  const errors: CheckError[] = [];
  for (const decl of program.decls) {
    if (decl.kind === "fn" && decl.body !== null) {
      checkFn(decl.name, decl.body, env, errors);
    }
  }
  return errors;
}

function checkFn(fnName: string, body: Stmt[], env: TypeEnv, errors: CheckError[]): void {
  const scope: Scope = new Map();
  const sig = env.functions.get(fnName);
  if (sig) {
    for (const param of sig.params) {
      scope.set(param.name, {
        type_: param.type_,
        owned: param.mode === "move",
        moved: false,
      });
    }
  }
  checkStmts(body, scope, env, errors);
}

function checkStmts(stmts: Stmt[], scope: Scope, env: TypeEnv, errors: CheckError[]): void {
  for (const stmt of stmts) {
    checkStmt(stmt, scope, env, errors);
  }
}

function checkStmt(stmt: Stmt, scope: Scope, env: TypeEnv, errors: CheckError[]): void {
  switch (stmt.kind) {
    case "expr":
    case "let":
    case "rebind":
    case "if":
    case "loop":
    case "match":
    case "break":
    case "select":
      break;
    default: {
      const _exhaustive: never = stmt;
    }
  }
  void scope; void env; void errors;
}

function checkExpr(expr: Expr, scope: Scope, env: TypeEnv, errors: CheckError[]): FitType {
  void expr; void scope; void env; void errors;
  return { kind: "unit", mode: "unrestricted" };
}
