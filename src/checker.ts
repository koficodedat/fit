import { Program, Stmt, Expr, Pos } from "./ast";
import { FitType, TypeEnv, buildTypeEnv, resolveVariant } from "./types";

export type CheckError = { message: string; pos: Pos };

type Binding = { type_: FitType; owned: boolean; moved: boolean };
type Scope = Map<string, Binding>;
type CapScope = Set<string>;

export function check(program: Program): CheckError[] {
  const { env, buildErrors } = buildTypeEnv(program);
  const errors: CheckError[] = [...buildErrors];
  for (const decl of program.decls) {
    if (decl.kind === "fn" && decl.body !== null) {
      checkFn(decl.name, decl.body, decl.pos, env, errors);
    }
  }
  return errors;
}

function checkFn(fnName: string, body: Stmt[], fnPos: Pos, env: TypeEnv, errors: CheckError[]): void {
  const scope: Scope = new Map();
  const caps: CapScope = new Set();
  const sig = env.functions.get(fnName);
  let enclosingErr: FitType | null = null;
  if (sig) {
    for (const param of sig.params) {
      scope.set(param.name, {
        type_: param.type_,
        owned: param.mode === "move",
        moved: false,
      });
    }
    for (const cap of sig.caps) caps.add(cap);
    if (sig.returnType.kind === "result") { enclosingErr = sig.returnType.err; }
  }
  checkStmts(body, scope, caps, env, enclosingErr, fnName, errors);
  const exitPos: Pos = body.length > 0 ? body[body.length - 1].pos : fnPos;
  for (const [name, binding] of scope) {
    if (binding.owned && !binding.moved && binding.type_.mode === "linear") {
      errors.push({
        message: `linear value '${name}' must be consumed before function returns`,
        pos: exitPos,
      });
    }
  }
}

function checkStmts(
  stmts: Stmt[],
  scope: Scope,
  caps: CapScope,
  env: TypeEnv,
  enclosingErr: FitType | null,
  enclosingFn: string,
  errors: CheckError[]
): void {
  for (const stmt of stmts) {
    checkStmt(stmt, scope, caps, env, enclosingErr, enclosingFn, errors);
  }
}

function checkStmt(
  stmt: Stmt,
  scope: Scope,
  caps: CapScope,
  env: TypeEnv,
  enclosingErr: FitType | null,
  enclosingFn: string,
  errors: CheckError[]
): void {
  switch (stmt.kind) {
    case "expr":
      checkExpr(stmt.expr, scope, caps, env, enclosingErr, enclosingFn, errors);
      break;
    case "let": {
      const initType = checkExpr(stmt.init, scope, caps, env, enclosingErr, enclosingFn, errors);
      scope.set(stmt.name, { type_: initType, owned: true, moved: false });
      break;
    }
    case "rebind": {
      if (!scope.has(stmt.name)) {
        errors.push({ message: `cannot rebind undefined variable '${stmt.name}'`, pos: stmt.pos });
        break;
      }
      const newType = checkExpr(stmt.expr, scope, caps, env, enclosingErr, enclosingFn, errors);
      // Old linear value gets auto-cleaned on rebind — not an error.
      scope.set(stmt.name, { type_: newType, owned: true, moved: false });
      break;
    }
    case "if": {
      checkExpr(stmt.cond, scope, caps, env, enclosingErr, enclosingFn, errors);
      const thenScope = cloneScope(scope);
      const elseScope = cloneScope(scope);
      checkStmts(stmt.then, thenScope, cloneCaps(caps), env, enclosingErr, enclosingFn, errors);
      checkInnerScopeExit(thenScope, scope, errors, stmt.pos);
      checkStmts(stmt.else_, elseScope, cloneCaps(caps), env, enclosingErr, enclosingFn, errors);
      checkInnerScopeExit(elseScope, scope, errors, stmt.pos);
      const merged = mergeScopes(scope, [thenScope, elseScope], errors, stmt.pos);
      for (const [k, v] of merged) scope.set(k, v);
      break;
    }
    case "loop": {
      const snap = snapshotTypestates(scope);
      const bodyScope = cloneScope(scope);
      checkStmts(stmt.body, bodyScope, cloneCaps(caps), env, enclosingErr, enclosingFn, errors);
      checkInnerScopeExit(bodyScope, scope, errors, stmt.pos);

      for (const [name, beforeState] of snap) {
        const afterBind = bodyScope.get(name);
        if (!afterBind || afterBind.moved) continue;
        if (afterBind.type_.kind === "resource" && afterBind.type_.typeState !== beforeState) {
          errors.push({
            message: `loop body changes typestate of '${name}' from '${beforeState}' to '${afterBind.type_.typeState}'; use recursion instead`,
            pos: stmt.pos,
          });
        }
      }

      for (const [name, binding] of scope) {
        if (bodyScope.get(name)?.moved) binding.moved = true;
      }
      break;
    }

    case "break":
      break; // still-owned linears get auto-cleaned; no linearity checker action
    case "select": {
      if (!caps.has(stmt.from)) {
        errors.push({
          message: `capability '${stmt.from}' not in scope for 'select'`,
          pos: stmt.pos,
        });
      } else {
        // Source cap is unrestricted — not consumed. Add projected atoms to scope.
        for (const atom of stmt.atoms) caps.add(atom);
      }
      break;
    }

    case "match": {
      const subjectType = checkExpr(stmt.expr, scope, caps, env, enclosingErr, enclosingFn, errors);
      // Consume linear scrutinee — match takes ownership.
      if (stmt.expr.kind === "var" && subjectType.mode === "linear") {
        consumeBinding(stmt.expr.name, scope, errors, stmt.expr.pos);
      }
      // Only enforce unknown-variant errors when the subject is a declared enum.
      // Extern/unresolved return types fall back to stubs silently.
      // Accept both "plain" (pre-enumDecls env) and "enum" (post-enumDecls env, Task 55).
      const subjectIsKnownEnum =
        (subjectType.kind === "plain" || subjectType.kind === "enum") &&
        env.enumDecls.has(subjectType.name);

      const branchScopes: Scope[] = [];
      for (const arm of stmt.arms) {
        const armScope = cloneScope(scope);
        // Names of linear payload bindings introduced by this arm — must be checked after
        // checkStmts because mergeScopes only walks preScope, not arm-local bindings.
        const armLinearBinds: string[] = [];
        if (arm.pattern.kind === "variant") {
          const resolved = resolveVariant(arm.pattern.name, arm.pattern.qualifier, env);
          const variantInfo = resolved.result;
          if (variantInfo === null) {
            // Emit error if: subject is a known enum (existing gate) OR a qualifier was given (always check explicit refs)
            if (subjectIsKnownEnum || arm.pattern.qualifier !== null) {
              errors.push({ message: resolved.error, pos: stmt.pos });
            }
            for (const bind of arm.pattern.binds) {
              armScope.set(bind, {
                type_: { kind: "plain", mode: "unrestricted", name: "?" },
                owned: true,
                moved: false,
              });
            }
          } else if (variantInfo.payload === null) {
            if (arm.pattern.binds.length > 0) {
              errors.push({
                message: `variant '${arm.pattern.name}' has no payload but pattern binds ${arm.pattern.binds.length} variable(s)`,
                pos: stmt.pos,
              });
            }
          } else {
            if (arm.pattern.binds.length === 0) {
              if (variantInfo.payload.mode === "linear") {
                errors.push({
                  message: `linear payload of variant '${arm.pattern.name}' must be bound to be consumed`,
                  pos: stmt.pos,
                });
              }
            } else if (arm.pattern.binds.length === 1) {
              armScope.set(arm.pattern.binds[0], {
                type_: variantInfo.payload,
                owned: true,
                moved: false,
              });
              if (variantInfo.payload.mode === "linear") {
                armLinearBinds.push(arm.pattern.binds[0]);
              }
            } else {
              errors.push({
                message: `variant '${arm.pattern.name}' has a single payload; pattern binds ${arm.pattern.binds.length} variables (use a record for multi-field payloads)`,
                pos: stmt.pos,
              });
              armScope.set(arm.pattern.binds[0], {
                type_: variantInfo.payload,
                owned: true,
                moved: false,
              });
              if (variantInfo.payload.mode === "linear") {
                armLinearBinds.push(arm.pattern.binds[0]);
              }
              for (let i = 1; i < arm.pattern.binds.length; i++) {
                armScope.set(arm.pattern.binds[i], {
                  type_: { kind: "plain", mode: "unrestricted", name: "?" },
                  owned: true,
                  moved: false,
                });
              }
            }
          }
        }
        const armVariantName = arm.pattern.kind === "variant" ? arm.pattern.name : "?";
        const armLinearBindsSet: ReadonlySet<string> = new Set(armLinearBinds);
        checkStmts(arm.body, armScope, cloneCaps(caps), env, enclosingErr, enclosingFn, errors);
        checkInnerScopeExit(armScope, scope, errors, stmt.pos, armLinearBindsSet);
        for (const bindName of armLinearBinds) {
          const b = armScope.get(bindName);
          if (b && !b.moved) {
            errors.push({
              message: `linear value '${bindName}' must be consumed in match arm for '${armVariantName}'`,
              pos: stmt.pos,
            });
          }
        }
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

function errorTypeCompatible(
  propagated: FitType,
  declared: FitType,
  _env: TypeEnv // reserved for nested-alias expansion (deferred design question)
): boolean {
  // Structural equality for unit types (e.g. Result<X, ()> propagated into Result<Y, ()>)
  if (propagated.kind === "unit" && declared.kind === "unit") return true;
  const pName = "name" in propagated ? propagated.name : null;
  // dName is used only for the equality check below; alias-membership uses declared.members
  // directly — comparing pName === declared.name would check alias name, not membership.
  const dName = "name" in declared ? declared.name : null;
  // Equality: same named type on both sides. If propagated is itself an alias
  // (e.g. type Inner = ...) this matches by alias name — flat string comparison,
  // not nested expansion. Nested expansion is the separate deferred case.
  if (pName !== null && pName === dName) return true;
  // Flat alias membership: declared is a union alias and propagated's name is listed
  if (declared.kind === "alias" && pName !== null) {
    return declared.members.includes(pName);
  }
  return false;
}

function checkExpr(
  expr: Expr,
  scope: Scope,
  caps: CapScope,
  env: TypeEnv,
  enclosingErr: FitType | null,
  enclosingFn: string,
  errors: CheckError[]
): FitType {
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
      const inner = checkExpr(expr.expr, scope, caps, env, enclosingErr, enclosingFn, errors);
      // Only consume a named var — temporaries (calls, literals) have no binding to mark moved.
      if (expr.expr.kind === "var" && inner.mode === "linear") {
        consumeBinding(expr.expr.name, scope, errors, expr.expr.pos);
      }
      return {
        kind: "result",
        mode: "unrestricted",
        ok: inner,
        err: { kind: "unit", mode: "unrestricted" },
      };
    }

    case "err": {
      const inner = checkExpr(expr.expr, scope, caps, env, enclosingErr, enclosingFn, errors);
      // Only consume a named var — temporaries (calls, literals) have no binding to mark moved.
      if (expr.expr.kind === "var" && inner.mode === "linear") {
        consumeBinding(expr.expr.name, scope, errors, expr.expr.pos);
      }
      return {
        kind: "result",
        mode: "unrestricted",
        ok: { kind: "unit", mode: "unrestricted" },
        err: inner,
      };
    }

    case "call": {
      // drop is a built-in consuming sink — no capability requirements
      if (expr.fn === "drop") {
        if (expr.args.length === 1 && expr.args[0].kind === "var") {
          checkExpr(expr.args[0], scope, caps, env, enclosingErr, enclosingFn, errors);
          consumeBinding(expr.args[0].name, scope, errors, expr.args[0].pos);
        } else {
          errors.push({ message: `drop requires a single variable argument`, pos: expr.pos });
          for (const arg of expr.args) checkExpr(arg, scope, caps, env, enclosingErr, enclosingFn, errors);
        }
        return { kind: "unit", mode: "unrestricted" };
      }

      const sig = env.functions.get(expr.fn);
      if (!sig) {
        // Unknown function: evaluate all args as lend (no consumption), skip cap check
        for (const arg of expr.args) checkExpr(arg, scope, caps, env, enclosingErr, enclosingFn, errors);
        return { kind: "plain", mode: "unrestricted", name: "?" };
      }

      for (const cap of sig.caps) {
        if (!caps.has(cap)) {
          errors.push({
            message: `missing capability '${cap}' required by '${expr.fn}'`,
            pos: expr.pos,
          });
        }
      }

      for (let i = 0; i < sig.params.length; i++) {
        const param = sig.params[i];
        const arg = expr.args[i];
        if (!arg) {
          errors.push({ message: `not enough arguments to '${expr.fn}'`, pos: expr.pos });
          continue;
        }
        checkExpr(arg, scope, caps, env, enclosingErr, enclosingFn, errors);

        if (arg.kind === "var") {
          const binding = scope.get(arg.name);
          if (
            binding &&
            param.type_.kind === "resource" &&
            param.type_.typeState !== null &&
            binding.type_.kind === "resource" &&
            !binding.moved
          ) {
            if (binding.type_.typeState !== param.type_.typeState) {
              errors.push({
                message: `argument '${arg.name}' has typestate '${binding.type_.typeState}', expected '${param.type_.typeState}'`,
                pos: arg.pos,
              });
            }
          }

          if (param.mode === "move" && binding?.type_.mode === "linear") {
            consumeBinding(arg.name, scope, errors, arg.pos);
          }
        }
      }
      for (let i = sig.params.length; i < expr.args.length; i++) {
        checkExpr(expr.args[i], scope, caps, env, enclosingErr, enclosingFn, errors);
        errors.push({ message: `too many arguments to '${expr.fn}'`, pos: expr.args[i].pos });
      }
      return sig.returnType;
    }

    case "try": {
      const innerType = checkExpr(expr.expr, scope, caps, env, enclosingErr, enclosingFn, errors);
      // Check expression-level first: if the inner expression isn't a Result at all,
      // the enclosingErr check is moot and would produce a confusing second error.
      if (innerType.kind !== "result") {
        errors.push({ message: `'?' applied to non-Result type`, pos: expr.pos });
        return { kind: "plain", mode: "unrestricted", name: "?" };
      }
      if (enclosingErr === null) {
        errors.push({
          message: `'?' in a function that does not return Result`,
          pos: expr.pos,
        });
      } else if (!errorTypeCompatible(innerType.err, enclosingErr, env)) {
        const propagatedName = "name" in innerType.err ? innerType.err.name : "()";
        const declaredName = "name" in enclosingErr ? enclosingErr.name : "()";
        errors.push({
          message: `cannot propagate error type '${propagatedName}' — not a member of '${declaredName}' declared by '${enclosingFn}'`,
          pos: expr.pos,
        });
      }
      // Error path: still-owned linears get auto-cleaned by FIT runtime — no checker action needed.
      return innerType.ok;
    }

    case "qualified_var":
      // Qualified variant reference in expression position (e.g. IoError.NotFound).
      // Variants are not values in FIT — this case is here for parser completeness.
      // Return unrestricted plain type; no binding consumption.
      return { kind: "plain", mode: "unrestricted", name: expr.name };

    default: {
      const _exhaustive: never = expr;
      return { kind: "unit", mode: "unrestricted" };
    }
  }
}

function checkInnerScopeExit(
  innerScope: Scope,
  outerScope: Scope,
  errors: CheckError[],
  pos: Pos,
  exclude?: ReadonlySet<string>
): void {
  for (const [name, binding] of innerScope) {
    if (outerScope.has(name)) continue;      // outer binding, not local
    if (exclude?.has(name)) continue;         // handled separately (e.g., armLinearBinds)
    if (binding.owned && !binding.moved && binding.type_.mode === "linear") {
      errors.push({
        message: `linear value '${name}' must be consumed before leaving scope`,
        pos,
      });
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

function cloneCaps(caps: CapScope): CapScope {
  return new Set(caps);
}

function mergeScopes(preScope: Scope, branches: Scope[], errors: CheckError[], pos: Pos): Scope {
  const result = cloneScope(preScope);
  if (branches.length === 0) return result;
  for (const [name, preBind] of preScope) {
    if (preBind.type_.mode !== "linear" || !preBind.owned || preBind.moved) continue;
    const movedIn = branches.map((b) => b.get(name)?.moved ?? false);
    const allMoved = movedIn.every((m) => m);
    const noneMoved = movedIn.every((m) => !m);
    if (!allMoved && !noneMoved) {
      errors.push({ message: `linear value '${name}' must be consumed on all branches`, pos });
      result.get(name)!.moved = true; // suppress scope-exit double-report for same binding
    } else {
      result.get(name)!.moved = allMoved;
    }
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
  if (binding.moved) return; // already reported by checkExpr var case
  if (!binding.owned) {
    errors.push({ message: `cannot move borrowed value '${name}'`, pos });
    return;
  }
  binding.moved = true;
}
