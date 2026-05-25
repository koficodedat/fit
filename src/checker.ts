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
    case "rebind": {
      if (!scope.has(stmt.name)) {
        errors.push({ message: `cannot rebind undefined variable '${stmt.name}'`, pos: stmt.pos });
        break;
      }
      const newType = checkExpr(stmt.expr, scope, env, errors);
      // Old linear value gets auto-cleaned on rebind — not an error.
      scope.set(stmt.name, { type_: newType, owned: true, moved: false });
      break;
    }
    case "if": {
      checkExpr(stmt.cond, scope, env, errors);
      const thenScope = cloneScope(scope);
      const elseScope = cloneScope(scope);
      checkStmts(stmt.then, thenScope, env, errors);
      checkStmts(stmt.else_, elseScope, env, errors);
      const merged = mergeScopes(scope, [thenScope, elseScope], errors, stmt.pos);
      for (const [k, v] of merged) scope.set(k, v);
      break;
    }
    case "loop": {
      const snap = snapshotTypestates(scope);
      const bodyScope = cloneScope(scope);
      checkStmts(stmt.body, bodyScope, env, errors);

      for (const [name, beforeState] of snap) {
        const afterBind = bodyScope.get(name);
        if (!afterBind || afterBind.moved) continue;
        if (afterBind.type_.kind === "resource" && afterBind.type_.typeState !== beforeState) {
          errors.push({
            message: `loop body changes typestate of '${name}' from ${beforeState} to ${afterBind.type_.typeState}; use recursion instead`,
            pos: stmt.pos,
          });
        }
      }

      // Propagate moves from loop body back to outer scope
      for (const [name, binding] of scope) {
        if (bodyScope.get(name)?.moved) binding.moved = true;
      }
      break;
    }

    case "break":  break; // still-owned linears get auto-cleaned; no linearity checker action
    case "select": break; // capability projection — Step 4 handles this
    case "match": {
      checkExpr(stmt.expr, scope, env, errors);
      const branchScopes: Scope[] = [];
      for (const arm of stmt.arms) {
        const armScope = cloneScope(scope);
        if (arm.pattern.kind === "variant") {
          for (const bind of arm.pattern.binds) {
            armScope.set(bind, {
              type_: { kind: "plain", mode: "unrestricted", name: "?" },
              owned: true,
              moved: false,
            });
          }
        }
        checkStmts(arm.body, armScope, env, errors);
        branchScopes.push(armScope);
      }
      const merged = mergeScopes(scope, branchScopes, errors, stmt.pos);
      for (const [k, v] of merged) scope.set(k, v);
      break;
    }
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

    case "call": {
      // drop is a built-in consuming sink
      if (expr.fn === "drop" && expr.args.length === 1 && expr.args[0].kind === "var") {
        checkExpr(expr.args[0], scope, env, errors);
        consumeBinding(expr.args[0].name, scope, errors, expr.args[0].pos);
        return { kind: "unit", mode: "unrestricted" };
      }

      const sig = env.functions.get(expr.fn);
      if (!sig) {
        // Unknown function: evaluate all args as lend (no consumption)
        for (const arg of expr.args) checkExpr(arg, scope, env, errors);
        return { kind: "plain", mode: "unrestricted", name: "?" };
      }

      for (let i = 0; i < sig.params.length; i++) {
        const param = sig.params[i];
        const arg = expr.args[i];
        if (!arg) {
          errors.push({ message: `not enough arguments to '${expr.fn}'`, pos: expr.pos });
          continue;
        }
        checkExpr(arg, scope, env, errors);

        if (arg.kind === "var") {
          const binding = scope.get(arg.name);
          // Typestate verification: only when both param and binding carry a named typestate
          if (
            binding &&
            param.type_.kind === "resource" && param.type_.typeState !== null &&
            binding.type_.kind === "resource" && !binding.moved
          ) {
            if (binding.type_.typeState !== param.type_.typeState) {
              errors.push({
                message: `argument '${arg.name}' has typestate '${binding.type_.typeState}', expected '${param.type_.typeState}'`,
                pos: arg.pos,
              });
            }
          }

          if (param.mode === "move") {
            consumeBinding(arg.name, scope, errors, arg.pos);
          }
        }
      }
      return sig.returnType;
    }

    case "try": {
      const innerType = checkExpr(expr.expr, scope, env, errors);
      if (innerType.kind !== "result") {
        errors.push({ message: `'?' applied to non-Result type`, pos: expr.pos });
        return { kind: "plain", mode: "unrestricted", name: "?" };
      }
      // Error path: still-owned linears get auto-cleaned by FIT runtime — no checker action needed.
      return innerType.ok;
    }

    default: {
      const _exhaustive: never = expr;
      return { kind: "unit", mode: "unrestricted" };
    }
  }
}

function cloneScope(scope: Scope): Scope {
  const clone: Scope = new Map();
  for (const [k, v] of scope) {
    clone.set(k, { ...v });
  }
  return clone;
}

function mergeScopes(preScope: Scope, branches: Scope[], errors: CheckError[], pos: Pos): Scope {
  const result = cloneScope(preScope);
  for (const [name, preBind] of preScope) {
    if (preBind.type_.mode !== "linear" || !preBind.owned || preBind.moved) continue;
    const movedIn = branches.map(b => b.get(name)?.moved ?? false);
    const allMoved  = movedIn.every(m => m);
    const noneMoved = movedIn.every(m => !m);
    if (!allMoved && !noneMoved) {
      errors.push({ message: `linear value '${name}' must be consumed on all branches`, pos });
    }
    result.get(name)!.moved = allMoved;
  }
  return result;
}


function snapshotTypestates(scope: Scope): Map<string, string | null> {
  const snap = new Map<string, string | null>();
  for (const [name, binding] of scope) {
    if (binding.type_.kind === "resource" && !binding.moved) {
      snap.set(name, binding.type_.typeState);
    }
  }
  return snap;
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

