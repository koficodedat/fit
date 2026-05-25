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
      checkExpr(stmt.expr, scope, env, errors);
      break;
    case "let": {
      const initType = checkExpr(stmt.init, scope, env, errors);
      scope.set(stmt.name, { type_: initType, owned: true, moved: false });
      break;
    }
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
}

function checkExpr(expr: Expr, scope: Scope, env: TypeEnv, errors: CheckError[]): FitType {
  switch (expr.kind) {
    case "unit_val":
      return { kind: "unit", mode: "unrestricted" };

    case "var": {
      const binding = scope.get(expr.name);
      if (!binding) {
        errors.push({ message: `undefined variable '${expr.name}'`, pos: expr.pos });
        return { kind: "plain", mode: "unrestricted", name: "?" };
      }
      if (binding.moved) {
        errors.push({ message: `value '${expr.name}' has already been moved`, pos: expr.pos });
      }
      return binding.type_;
    }

    case "ok": {
      const inner = checkExpr(expr.expr, scope, env, errors);
      return { kind: "result", mode: "unrestricted", ok: inner, err: { kind: "unit", mode: "unrestricted" } };
    }

    case "err": {
      const inner = checkExpr(expr.expr, scope, env, errors);
      return { kind: "result", mode: "unrestricted", ok: { kind: "unit", mode: "unrestricted" }, err: inner };
    }

    case "call":
    case "try":
      return { kind: "plain", mode: "unrestricted", name: "?" };

    default: {
      const _exhaustive: never = expr;
      return { kind: "unit", mode: "unrestricted" };
    }
  }
}

function consumeBinding(name: string, scope: Scope, errors: CheckError[], pos: Pos): void {
  const binding = scope.get(name);
  if (!binding) return;
  if (binding.moved) {
    errors.push({ message: `value '${name}' has already been moved`, pos });
    return;
  }
  if (!binding.owned) {
    errors.push({ message: `cannot move borrowed value '${name}'`, pos });
    return;
  }
  binding.moved = true;
}

// Suppress unused warning until Task 3 uses consumeBinding from call handling
void consumeBinding;
