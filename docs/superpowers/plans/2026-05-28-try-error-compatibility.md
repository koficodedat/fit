# `?` Error-Type Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce §7's implicit-widening rule at every `?` site — the checker must reject `e?` when `e`'s error type is not equal to, or a flat member of, the enclosing function's declared error type.

**Architecture:** Three tightly-coupled pieces in `checker.ts`: (1) extract the enclosing function's declared error type in `checkFn` and thread it as a new `enclosingErr: FitType | null` parameter through `checkStmts → checkStmt → checkExpr`; (2) add a pure `errorTypeCompatible` helper (equality + flat alias-membership); (3) enforce at the `try` case using both. No changes to `types.ts`, `parser.ts`, or `ast.ts`. Flat alias-membership only — nested-alias expansion is a deferred design question per the escalation trigger.

**Tech Stack:** TypeScript, Jest (`npm test`), FIT checker (`node dist/src/main.js check <file>`).

---

## Key source locations (read before implementing)

- `src/checker.ts:21` — `checkFn`: seeds scope and caps; does NOT currently extract enclosing error type
- `src/checker.ts:47` — `checkStmts`: forwards to `checkStmt`; no `enclosingErr` param
- `src/checker.ts:59` — `checkStmt`: 17 call sites inside it that need `enclosingErr` added
- `src/checker.ts:242` — `checkExpr`: 8 recursive call sites; `try` case at line 360 is the enforcement point
- `src/checker.ts:360–368` — current `try` case: discards `innerType.err`, no enclosing-type check
- `src/types.ts:9–22` — `FitType` union: `alias` has `name: string; members: string[]` (member names are **unresolved strings**, not expanded)
- `src/types.ts:21` — comment: "member names are unresolved — look up via ResolveEnv.aliases" — flat string-membership is correct and sufficient for this fix

---

## File structure

```
src/
  checker.ts        ← Modify: add errorTypeCompatible, thread enclosingErr, enforce at try
tests/
  checker.test.ts   ← Modify: add 4 inline tests for exact error messages
  should_fail/
    try_incompatible_error.fit   ← Create: IoError in HttpError context, no union
    try_no_result_fn.fit         ← Create: ? in a non-Result-returning function
  should_pass/
    try_member_of_union.fit      ← Create: IoError widened to ServerError alias
    try_equal_error.fit          ← Create: same error type on both sides
docs/
  stdlib-probe-findings.md      ← Modify: before/after note + spec note on flat membership
  FIT-SPEC-v2.md                ← Modify: add implementation note to §7
```

---

## Task 1: Write the four test programs and establish the baseline

**Files:**
- Create: `tests/should_fail/try_incompatible_error.fit`
- Create: `tests/should_fail/try_no_result_fn.fit`
- Create: `tests/should_pass/try_member_of_union.fit`
- Create: `tests/should_pass/try_equal_error.fit`

- [ ] **Step 1: Write `tests/should_fail/try_incompatible_error.fit`**

```
enum IoError { FileNotFound }
enum HttpError { BadRequest }

fn open(path: String) -> Result<String, IoError>

fn serve() -> Result<(), HttpError> {
    let content = open("index.html")?
    Ok(())
}
```

This is the before/after flip file: currently accepted (0 errors), must be rejected after the fix with `cannot propagate error type 'IoError' — not a member of 'HttpError' declared by enclosing function`.

- [ ] **Step 2: Write `tests/should_fail/try_no_result_fn.fit`**

```
enum IoError { Disconnected }
fn read() -> Result<String, IoError>

fn test() -> String {
    read()?
}
```

`read()` returns a `Result` so the existing `'?' applied to non-Result type` check does NOT fire. Currently this is silently accepted (returns `String`). After the fix, enclosing return type `String` is not a `Result`, so `enclosingErr = null` → new error `'?' in a function that does not return Result`.

- [ ] **Step 3: Write `tests/should_pass/try_member_of_union.fit`**

```
enum IoError { FileNotFound }
enum HttpError { BadRequest }
enum NetError { Refused }

type ServerError = IoError | HttpError | NetError

fn open(path: String) -> Result<String, IoError>
fn validate(s: String) -> Result<String, HttpError>

fn serve() -> Result<String, ServerError> {
    let content = open("index.html")?
    let validated = validate(content)?
    Ok(validated)
}
```

Both `open()?` (IoError) and `validate()?` (HttpError) are flat members of the `ServerError` alias. Must be accepted. This is the `serve_request` shape from the stdlib probe.

- [ ] **Step 4: Write `tests/should_pass/try_equal_error.fit`**

```
enum ApiError { Timeout, RateLimit }
fn fetch() -> Result<String, ApiError>

fn get_data() -> Result<String, ApiError> {
    let data = fetch()?
    Ok(data)
}
```

Propagated error type (`ApiError`) equals declared error type (`ApiError`). Must be accepted.

- [ ] **Step 5: Run tests and confirm the baseline**

```bash
npm --prefix /Users/kofi/_/fit test 2>&1 | tail -15
```

Expected output:
```
PASS tests/suite.test.ts
  should_fail
    ✓ try_incompatible_error.fit produces at least one error    ← WRONG: will show ✗ (0 errors)
    ✓ try_no_result_fn.fit produces at least one error          ← WRONG: will show ✗ (0 errors)
  should_pass
    ✓ try_member_of_union.fit produces no errors
    ✓ try_equal_error.fit produces no errors
```

The two `should_fail` files produce 0 errors (incorrectly accepted). That is the failing test baseline — exactly the gap the fix must close. The two `should_pass` files already pass correctly.

- [ ] **Step 6: Commit the test programs**

```bash
git -C /Users/kofi/_/fit add tests/should_fail/try_incompatible_error.fit tests/should_fail/try_no_result_fn.fit tests/should_pass/try_member_of_union.fit tests/should_pass/try_equal_error.fit
git -C /Users/kofi/_/fit commit -m "test(try-compat): add four ? error-type compatibility test programs"
```

---

## Task 2: Implement the fix — three pieces in `checker.ts`

**Files:**
- Modify: `src/checker.ts`
- Modify: `tests/checker.test.ts`

### Piece 1 — Add `errorTypeCompatible` helper

- [ ] **Step 1: Add `errorTypeCompatible` to `checker.ts` just before `checkExpr`**

Insert at line 242 (before `function checkExpr`). This is a pure function — no mutation, no side effects.

```typescript
function errorTypeCompatible(propagated: FitType, declared: FitType, _env: TypeEnv): boolean {
  const pName = "name" in propagated ? propagated.name : null;
  const dName = "name" in declared ? declared.name : null;
  // Equality: same named type on both sides
  if (pName !== null && pName === dName) return true;
  // Flat alias membership: declared is a union alias and propagated's name is listed
  if (declared.kind === "alias" && pName !== null) {
    return declared.members.includes(pName);
  }
  return false;
}
```

`_env` is accepted for forward-compatibility (nested-alias expansion would need it) but is intentionally unused — flat string-membership is sufficient and correct for all current test programs. The `_` prefix suppresses any unused-parameter lint.

### Piece 2 — Thread `enclosingErr` through the checking walk

- [ ] **Step 2: Update `checkFn` (lines 21–45)**

Replace the entire `checkFn` function with:

```typescript
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
    if (sig.returnType.kind === "result") {
      enclosingErr = sig.returnType.err;
    }
  }
  checkStmts(body, scope, caps, env, enclosingErr, errors);
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
```

Key change: `enclosingErr` extracted from `sig.returnType.err` when return type is a `Result`; passed as new fifth argument to `checkStmts`.

- [ ] **Step 3: Update `checkStmts` (lines 47–57)**

Replace with:

```typescript
function checkStmts(
  stmts: Stmt[],
  scope: Scope,
  caps: CapScope,
  env: TypeEnv,
  enclosingErr: FitType | null,
  errors: CheckError[]
): void {
  for (const stmt of stmts) {
    checkStmt(stmt, scope, caps, env, enclosingErr, errors);
  }
}
```

- [ ] **Step 4: Update `checkStmt` (lines 59–240) — add parameter and update all 9 internal call sites**

Replace the entire `checkStmt` function with:

```typescript
function checkStmt(
  stmt: Stmt,
  scope: Scope,
  caps: CapScope,
  env: TypeEnv,
  enclosingErr: FitType | null,
  errors: CheckError[]
): void {
  switch (stmt.kind) {
    case "expr":
      checkExpr(stmt.expr, scope, caps, env, enclosingErr, errors);
      break;
    case "let": {
      const initType = checkExpr(stmt.init, scope, caps, env, enclosingErr, errors);
      scope.set(stmt.name, { type_: initType, owned: true, moved: false });
      break;
    }
    case "rebind": {
      if (!scope.has(stmt.name)) {
        errors.push({ message: `cannot rebind undefined variable '${stmt.name}'`, pos: stmt.pos });
        break;
      }
      const newType = checkExpr(stmt.expr, scope, caps, env, enclosingErr, errors);
      // Old linear value gets auto-cleaned on rebind — not an error.
      scope.set(stmt.name, { type_: newType, owned: true, moved: false });
      break;
    }
    case "if": {
      checkExpr(stmt.cond, scope, caps, env, enclosingErr, errors);
      const thenScope = cloneScope(scope);
      const elseScope = cloneScope(scope);
      checkStmts(stmt.then, thenScope, cloneCaps(caps), env, enclosingErr, errors);
      checkInnerScopeExit(thenScope, scope, errors, stmt.pos);
      checkStmts(stmt.else_, elseScope, cloneCaps(caps), env, enclosingErr, errors);
      checkInnerScopeExit(elseScope, scope, errors, stmt.pos);
      const merged = mergeScopes(scope, [thenScope, elseScope], errors, stmt.pos);
      for (const [k, v] of merged) scope.set(k, v);
      break;
    }
    case "loop": {
      const snap = snapshotTypestates(scope);
      const bodyScope = cloneScope(scope);
      checkStmts(stmt.body, bodyScope, cloneCaps(caps), env, enclosingErr, errors);
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
      const subjectType = checkExpr(stmt.expr, scope, caps, env, enclosingErr, errors);
      // Consume linear scrutinee — match takes ownership.
      if (stmt.expr.kind === "var" && subjectType.mode === "linear") {
        consumeBinding(stmt.expr.name, scope, errors, stmt.expr.pos);
      }
      // Only enforce unknown-variant errors when the subject is a declared enum.
      // Extern/unresolved return types fall back to stubs silently.
      // Accept both "plain" (pre-enumDecls env) and "enum" (post-enumDecls env, Task 55).
      const subjectIsKnownEnum =
        (subjectType.kind === "plain" || subjectType.kind === "enum") &&
        [...env.enums.values()].some((v) => v.enumName === subjectType.name);

      const branchScopes: Scope[] = [];
      for (const arm of stmt.arms) {
        const armScope = cloneScope(scope);
        // Names of linear payload bindings introduced by this arm — must be checked after
        // checkStmts because mergeScopes only walks preScope, not arm-local bindings.
        const armLinearBinds: string[] = [];
        if (arm.pattern.kind === "variant") {
          const variantInfo = env.enums.get(arm.pattern.name);
          if (!variantInfo) {
            if (subjectIsKnownEnum) {
              errors.push({
                message: `unknown variant '${arm.pattern.name}' in match pattern`,
                pos: stmt.pos,
              });
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
        checkStmts(arm.body, armScope, cloneCaps(caps), env, enclosingErr, errors);
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
```

Changed lines (all mechanical): `checkExpr` gets `enclosingErr` as 5th arg; `checkStmts` gets `enclosingErr` as 5th arg.

### Piece 3 — Update `checkExpr` and enforce at the `try` site

- [ ] **Step 5: Replace the `checkExpr` function signature and update all 8 internal call sites, enforcing at the `try` case**

Replace the entire `checkExpr` function with:

```typescript
function checkExpr(
  expr: Expr,
  scope: Scope,
  caps: CapScope,
  env: TypeEnv,
  enclosingErr: FitType | null,
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
      const inner = checkExpr(expr.expr, scope, caps, env, enclosingErr, errors);
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
      const inner = checkExpr(expr.expr, scope, caps, env, enclosingErr, errors);
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
          checkExpr(expr.args[0], scope, caps, env, enclosingErr, errors);
          consumeBinding(expr.args[0].name, scope, errors, expr.args[0].pos);
        } else {
          errors.push({ message: `drop requires a single variable argument`, pos: expr.pos });
          for (const arg of expr.args) checkExpr(arg, scope, caps, env, enclosingErr, errors);
        }
        return { kind: "unit", mode: "unrestricted" };
      }

      const sig = env.functions.get(expr.fn);
      if (!sig) {
        // Unknown function: evaluate all args as lend (no consumption), skip cap check
        for (const arg of expr.args) checkExpr(arg, scope, caps, env, enclosingErr, errors);
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
        checkExpr(arg, scope, caps, env, enclosingErr, errors);

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
        checkExpr(expr.args[i], scope, caps, env, enclosingErr, errors);
        errors.push({ message: `too many arguments to '${expr.fn}'`, pos: expr.args[i].pos });
      }
      return sig.returnType;
    }

    case "try": {
      const innerType = checkExpr(expr.expr, scope, caps, env, enclosingErr, errors);
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
        const propagatedName = "name" in innerType.err ? innerType.err.name : "?";
        const declaredName = "name" in enclosingErr ? enclosingErr.name : "?";
        errors.push({
          message: `cannot propagate error type '${propagatedName}' — not a member of '${declaredName}' declared by enclosing function`,
          pos: expr.pos,
        });
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
```

The only semantic change is the `try` case (new `enclosingErr` check). All other cases are unchanged except threading `enclosingErr` through recursive calls.

- [ ] **Step 6: Run the full test suite**

```bash
npm --prefix /Users/kofi/_/fit test 2>&1 | tail -20
```

Expected:
```
Tests: 288 passed, 288 total   (284 existing + 4 new)
```

All four new files should now behave correctly:
- `try_incompatible_error.fit` → at least 1 error ✓ (was 0, now fixed)
- `try_no_result_fn.fit` → at least 1 error ✓ (was 0, now fixed)
- `try_member_of_union.fit` → 0 errors ✓
- `try_equal_error.fit` → 0 errors ✓

If any test fails, diagnose from the error output before continuing. Do not proceed to Step 7 with failing tests.

- [ ] **Step 7: Add inline checker.test.ts tests for exact error messages**

Add a new describe block at the end of `tests/checker.test.ts`:

```typescript
describe("? error-type compatibility (§7)", () => {
  it("equal error types: ? is accepted", () => {
    const src = `
      enum ApiError { Timeout }
      fn fetch() -> Result<String, ApiError>
      fn get_data() -> Result<String, ApiError> {
        let data = fetch()?
        Ok(data)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("member-of-union: IoError in ServerError alias is accepted", () => {
    const src = `
      enum IoError { NotFound }
      enum HttpError { BadRequest }
      type AppError = IoError | HttpError
      fn open() -> Result<String, IoError>
      fn handle() -> Result<String, AppError> {
        let content = open()?
        Ok(content)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("incompatible error types: error names both appear in the message", () => {
    const src = `
      enum IoError { NotFound }
      enum HttpError { BadRequest }
      fn open() -> Result<String, IoError>
      fn serve() -> Result<(), HttpError> {
        let content = open()?
        Ok(())
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("IoError"))).toBe(true);
    expect(errors.some((e) => e.message.includes("HttpError"))).toBe(true);
  });

  it("? in non-Result function: error message mentions 'does not return Result'", () => {
    const src = `
      enum IoError { NotFound }
      fn read() -> Result<String, IoError>
      fn test() -> String {
        read()?
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("does not return Result"))).toBe(true);
  });
});
```

- [ ] **Step 8: Run full test suite again and confirm all pass**

```bash
npm --prefix /Users/kofi/_/fit test 2>&1 | tail -10
```

Expected: `Tests: 292 passed, 292 total` (284 + 4 suite + 4 inline). No failures.

- [ ] **Step 9: Build and regression check — server.fit must still pass**

```bash
npm --prefix /Users/kofi/_/fit run build 2>&1 | tail -5
node /Users/kofi/_/fit/dist/src/main.js check /Users/kofi/_/fit/tests/stdlib-probe/server.fit 2>&1
echo "exit: $?"
```

Expected: no output, `exit: 0`. `server.fit` has `type ServerError = IoError | HttpError | NetError` and `serve_request`/`main` return `Result<(), ServerError>`. All `?` sites propagate flat members of `ServerError` — they must continue to pass after this fix.

If `server.fit` fails here, STOP — do not commit. Diagnose the failure; it is a regression.

- [ ] **Step 10: Commit the implementation**

```bash
cd /Users/kofi/_/fit
npm run build 2>&1 | tail -5
git add src/checker.ts tests/checker.test.ts
git commit -m "feat(checker): enforce ? error-type compatibility per §7

The try case now threads enclosingErr (the enclosing function's declared
error type) through checkStmts/checkStmt/checkExpr and rejects ? when:
- the error type is incompatible with the declared type (not equal, not a
  flat member of a declared alias union), OR
- the enclosing function does not return Result at all.

errorTypeCompatible(): equality + flat alias-membership. Nested-alias
expansion is deferred (escalation trigger per spec note — flat membership
is correct and sufficient for all current programs).

Fixes: try_incompatible_error.fit now rejected; try_no_result_fn.fit now
rejected. server.fit still passes (ServerError union covers all sites)."
```

---

## Task 3: Update docs — findings doc before/after note and §7 spec note

**Files:**
- Modify: `docs/stdlib-probe-findings.md`
- Modify: `docs/FIT-SPEC-v2.md`

- [ ] **Step 1: Add before/after note to `docs/stdlib-probe-findings.md`**

Find the `? error type compatibility not enforced` row in the PoC limitations table and update the Workaround column:

Old text (in the table):
```
| **`?` error type compatibility not enforced** (new — not in poc-findings.md) | server.fit | `serve_request` mixes `IoError` and `HttpError` under `?`; checker accepted this silently. Fix: added `type ServerError = IoError \| HttpError \| NetError` union alias and updated `serve_request`/`main` return types to `Result<(), ServerError>` for semantic correctness. |
```

Replace with:
```
| **`?` error type compatibility** — now enforced (§7) | server.fit | Was: checker silently accepted mixed error types. Fix applied in checker.ts: `errorTypeCompatible` helper + `enclosingErr` threading enforces the §7 rule. `try_incompatible_error.fit` is the before/after flip: 0 errors → 1 error. `server.fit` continues to pass because `type ServerError = IoError \| HttpError \| NetError` makes all `?` sites flat-member compliant. |
```

- [ ] **Step 2: Add implementation note to §7 in `docs/FIT-SPEC-v2.md`**

Find the §7 section and add after its existing content:

```markdown
**Implementation note (PoC, 2026-05-28):** The `?` compatibility rule is now enforced. `e?` is legal iff:

1. The error type of `e` equals the enclosing function's declared error type (same name), OR
2. The enclosing function's error type is a named union alias and the error type of `e` is a flat member of that alias (string-membership against `alias.members`).

Nested-alias expansion (where a member is itself an alias) is **not** implemented — it would require alias-resolution beyond the current flat-member model. Whether `?` widening should see through nested aliases is a deferred design question. All current programs use flat unions (leaf enums as members), so flat membership is correct and sufficient.

Error messages:
- `cannot propagate error type 'X' — not a member of 'Y' declared by enclosing function`
- `'?' in a function that does not return Result`
```

- [ ] **Step 3: Commit the docs updates**

```bash
git -C /Users/kofi/_/fit add docs/stdlib-probe-findings.md docs/FIT-SPEC-v2.md
git -C /Users/kofi/_/fit commit -m "docs: record ? error-type enforcement — findings update + §7 spec note

stdlib-probe-findings: before/after flip on try_incompatible_error.fit;
server.fit continues to pass via ServerError union alias.
FIT-SPEC-v2.md §7: implementation note — flat membership rule, nested-alias
expansion deferred as named design question."
```

- [ ] **Step 4: Final verification**

```bash
npm --prefix /Users/kofi/_/fit test 2>&1 | tail -5
```

Expected: all tests pass. No regressions.
