# Capability Checker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Step 4 of the FIT PoC — verify capability requirements at call sites, handle `select` atom projection, and thread a CapScope through the linearity checker.

**Architecture:** Capabilities are unrestricted (not linear), so they're tracked as a `Set<string>` called `CapScope`. It's initialized per function from the `using` clause, threaded through all statement/expression checks, and augmented by `select` statements. Call sites verify that all caps required by the callee are present in scope. No changes to `TypeEnv` or `types.ts` — `FunctionSig.caps: string[]` already carries the information.

**Tech Stack:** TypeScript, Jest (`npm test`). All existing files are in `src/`. Tests live in `tests/checker.test.ts`.

---

## Context for implementers

### Existing system (read before starting)

The linearity checker lives in `src/checker.ts` (~270 lines). It already handles:
- Move/lend tracking for linear values
- Typestate transitions and loop invariant
- Branch exhaustiveness (if/match)
- `drop` built-in consumption

The public API is `check(program: Program): CheckError[]`. Internal helper functions are:
```
checkFn(fnName, body, env, errors)
checkStmts(stmts, scope, env, errors)
checkStmt(stmt, scope, env, errors)
checkExpr(expr, scope, env, errors)
```

`FunctionSig.caps: string[]` (from `src/types.ts`) already holds the capability names from `using` clauses. `buildTypeEnv` in `src/types.ts` populates this from `decl.caps`.

The AST types are in `src/ast.ts`:
- `Decl.fn` has `caps: string[]`
- `Stmt.select` has `atoms: string[]` and `from: string`

### What Step 4 must check

From `CLAUDE.md`:
1. Every `using Cap` in a function signature is satisfied at each call site.
2. Strict resolution — exactly one cap of a given type in scope. (A `Set<string>` enforces this by deduplication.)
3. `select Read from Fs` produces `Read` in scope; `Fs` is not consumed.
4. A function with no `using` clause calling a function that requires one → error at call site (falls out naturally from rule 1).

### Known constraints
- Neither canonical program uses `select` inside branches — so no branch-scoping of caps is needed for PoC.
- Unknown functions (not in `env.functions`) skip both linearity and capability checks.
- `drop` is a built-in with no capability requirements.
- All tests currently pass: `npm test` → 192 tests, 5 suites.

---

## File structure

| File | Change |
|------|--------|
| `src/checker.ts` | Add `CapScope`, thread through helpers, implement call-site check + `select` |
| `tests/checker.test.ts` | Add capability checker describe block (~12 new tests) |

No other files change.

---

## Task 1: Thread CapScope through all check functions (plumbing)

This task adds `caps: CapScope` to internal function signatures and initializes it from `sig.caps`. No behavior changes — all 192 existing tests must still pass after this task.

**Files:**
- Modify: `src/checker.ts`

- [ ] **Step 1: Add `CapScope` type alias near the top of `src/checker.ts`**

After the existing `type Scope = Map<string, Binding>;` line, add:

```typescript
type CapScope = Set<string>;
```

- [ ] **Step 2: Modify `checkFn` to initialize CapScope from the function's caps**

Replace the current `checkFn`:

```typescript
function checkFn(fnName: string, body: Stmt[], env: TypeEnv, errors: CheckError[]): void {
  const scope: Scope = new Map();
  const caps: CapScope = new Set();
  const sig = env.functions.get(fnName);
  if (sig) {
    for (const param of sig.params) {
      scope.set(param.name, {
        type_: param.type_,
        owned: param.mode === "move",
        moved: false,
      });
    }
    for (const cap of sig.caps) caps.add(cap);
  }
  checkStmts(body, scope, caps, env, errors);
}
```

- [ ] **Step 3: Add `caps: CapScope` to `checkStmts` and thread through**

Replace:
```typescript
function checkStmts(stmts: Stmt[], scope: Scope, env: TypeEnv, errors: CheckError[]): void {
  for (const stmt of stmts) {
    checkStmt(stmt, scope, env, errors);
  }
}
```

With:
```typescript
function checkStmts(stmts: Stmt[], scope: Scope, caps: CapScope, env: TypeEnv, errors: CheckError[]): void {
  for (const stmt of stmts) {
    checkStmt(stmt, scope, caps, env, errors);
  }
}
```

- [ ] **Step 4: Add `caps: CapScope` to `checkStmt` and thread through every case**

Replace the `checkStmt` signature and all recursive calls inside it. The complete replacement:

```typescript
function checkStmt(stmt: Stmt, scope: Scope, caps: CapScope, env: TypeEnv, errors: CheckError[]): void {
  switch (stmt.kind) {
    case "expr":
      checkExpr(stmt.expr, scope, caps, env, errors);
      break;
    case "let": {
      const initType = checkExpr(stmt.init, scope, caps, env, errors);
      scope.set(stmt.name, { type_: initType, owned: true, moved: false });
      break;
    }
    case "rebind": {
      if (!scope.has(stmt.name)) {
        errors.push({ message: `cannot rebind undefined variable '${stmt.name}'`, pos: stmt.pos });
        break;
      }
      const newType = checkExpr(stmt.expr, scope, caps, env, errors);
      // Old linear value gets auto-cleaned on rebind — not an error.
      scope.set(stmt.name, { type_: newType, owned: true, moved: false });
      break;
    }
    case "if": {
      checkExpr(stmt.cond, scope, caps, env, errors);
      const thenScope = cloneScope(scope);
      const elseScope = cloneScope(scope);
      checkStmts(stmt.then, thenScope, caps, env, errors);
      checkStmts(stmt.else_, elseScope, caps, env, errors);
      const merged = mergeScopes(scope, [thenScope, elseScope], errors, stmt.pos);
      for (const [k, v] of merged) scope.set(k, v);
      break;
    }
    case "loop": {
      const snap = snapshotTypestates(scope);
      const bodyScope = cloneScope(scope);
      checkStmts(stmt.body, bodyScope, caps, env, errors);

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

      for (const [name, binding] of scope) {
        if (bodyScope.get(name)?.moved) binding.moved = true;
      }
      break;
    }

    case "break":  break; // still-owned linears get auto-cleaned; no linearity checker action
    case "select": break; // capability projection — Task 3 implements this; no-op for now

    case "match": {
      checkExpr(stmt.expr, scope, caps, env, errors);
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
        checkStmts(arm.body, armScope, caps, env, errors);
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

- [ ] **Step 5: Add `caps: CapScope` to `checkExpr` and thread through every recursive call**

Replace the `checkExpr` signature and all recursive calls inside it. The complete replacement:

```typescript
function checkExpr(expr: Expr, scope: Scope, caps: CapScope, env: TypeEnv, errors: CheckError[]): FitType {
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
      const inner = checkExpr(expr.expr, scope, caps, env, errors);
      if (expr.expr.kind === "var" && inner.mode === "linear") {
        consumeBinding(expr.expr.name, scope, errors, expr.expr.pos);
      }
      return { kind: "result", mode: "unrestricted", ok: inner, err: { kind: "unit", mode: "unrestricted" } };
    }

    case "err": {
      const inner = checkExpr(expr.expr, scope, env, errors);
      if (expr.expr.kind === "var" && inner.mode === "linear") {
        consumeBinding(expr.expr.name, scope, errors, expr.expr.pos);
      }
      return { kind: "result", mode: "unrestricted", ok: { kind: "unit", mode: "unrestricted" }, err: inner };
    }

    case "call": {
      // drop is a built-in consuming sink — no capability requirements
      if (expr.fn === "drop" && expr.args.length === 1 && expr.args[0].kind === "var") {
        checkExpr(expr.args[0], scope, caps, env, errors);
        consumeBinding(expr.args[0].name, scope, errors, expr.args[0].pos);
        return { kind: "unit", mode: "unrestricted" };
      }

      const sig = env.functions.get(expr.fn);
      if (!sig) {
        // Unknown function: evaluate all args as lend (no consumption), skip cap check
        for (const arg of expr.args) checkExpr(arg, scope, caps, env, errors);
        return { kind: "plain", mode: "unrestricted", name: "?" };
      }

      for (let i = 0; i < sig.params.length; i++) {
        const param = sig.params[i];
        const arg = expr.args[i];
        if (!arg) {
          errors.push({ message: `not enough arguments to '${expr.fn}'`, pos: expr.pos });
          continue;
        }
        checkExpr(arg, scope, caps, env, errors);

        if (arg.kind === "var") {
          const binding = scope.get(arg.name);
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
      const innerType = checkExpr(expr.expr, scope, caps, env, errors);
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
```

> **Note on `err` case:** the original has a typo — `checkExpr(expr.expr, scope, env, errors)` is missing `caps`. The replacement above fixes it: `checkExpr(expr.expr, scope, caps, env, errors)`.

- [ ] **Step 6: Run all tests — expect 192 passing, 0 failing**

```bash
npm test
```

Expected output:
```
Tests: 192 passed, 192 total
```

If any test fails, re-read the above diffs carefully. The only change is adding `caps` to function signatures — no behavior should change.

- [ ] **Step 7: Commit**

```bash
git add src/checker.ts
git commit -m "feat(checker): thread CapScope through all check functions — plumbing for Step 4"
```

---

## Task 2: Call-site capability verification

Implement the actual cap check in `checkExpr` case `"call"` and write tests for it.

**Files:**
- Modify: `src/checker.ts` (add cap check in call case)
- Modify: `tests/checker.test.ts` (add `describe("capability checking at call sites", ...)`)

- [ ] **Step 1: Write the failing tests first**

Add this describe block at the end of `tests/checker.test.ts`:

```typescript
describe("capability checking at call sites", () => {
  it("function can call another with matching cap in scope", () => {
    const src = `
      fn needs_net() using Net -> ()
      fn has_net() using Net -> () { needs_net() }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("function without using clause calling a cap-requiring function produces an error", () => {
    const src = `
      fn needs_net() using Net -> ()
      fn no_caps() -> () { needs_net() }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("missing capability 'Net'");
    expect(errors[0].message).toContain("needs_net");
  });

  it("function missing one of two required caps produces an error", () => {
    const src = `
      fn needs_two() using Net, ChargeCard -> ()
      fn has_net_only() using Net -> () { needs_two() }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("missing capability 'ChargeCard'");
    expect(errors[0].message).toContain("needs_two");
  });

  it("function with both required caps produces no error", () => {
    const src = `
      fn needs_two() using Net, ChargeCard -> ()
      fn has_both() using Net, ChargeCard -> () { needs_two() }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("unknown function (not in env) skips cap check — no error", () => {
    const src = `
      fn no_caps() -> () { unknown_fn() }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("error message names the missing cap and the callee", () => {
    const src = `
      fn send_email() using Net -> ()
      fn no_caps() -> () { send_email() }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors[0].message).toBe("missing capability 'Net' required by 'send_email'");
  });
});
```

- [ ] **Step 2: Run tests — expect new tests to FAIL**

```bash
npm test -- --testPathPattern=checker
```

Expected: the 6 new tests in "capability checking at call sites" fail — the first test passes (trivially — no checking yet means no error), but the tests that expect errors will fail because the checker doesn't check caps yet.

Specifically, "function without using clause calling a cap-requiring function produces an error" will fail with `Expected: 1, Received: 0` (no errors currently produced).

- [ ] **Step 3: Implement cap verification in `checkExpr` call case**

In `src/checker.ts`, in the `checkExpr` function, locate the `case "call":` block. After the `if (!sig)` early return, and BEFORE the parameter loop, add the capability check:

```typescript
      const sig = env.functions.get(expr.fn);
      if (!sig) {
        // Unknown function: evaluate all args as lend (no consumption), skip cap check
        for (const arg of expr.args) checkExpr(arg, scope, caps, env, errors);
        return { kind: "plain", mode: "unrestricted", name: "?" };
      }

      // Verify all capability requirements are satisfied in the current scope
      for (const cap of sig.caps) {
        if (!caps.has(cap)) {
          errors.push({ message: `missing capability '${cap}' required by '${expr.fn}'`, pos: expr.pos });
        }
      }

      for (let i = 0; i < sig.params.length; i++) {
        // ... existing parameter loop unchanged ...
```

The full updated `case "call":` block (complete, to avoid any ambiguity):

```typescript
    case "call": {
      // drop is a built-in consuming sink — no capability requirements
      if (expr.fn === "drop" && expr.args.length === 1 && expr.args[0].kind === "var") {
        checkExpr(expr.args[0], scope, caps, env, errors);
        consumeBinding(expr.args[0].name, scope, errors, expr.args[0].pos);
        return { kind: "unit", mode: "unrestricted" };
      }

      const sig = env.functions.get(expr.fn);
      if (!sig) {
        // Unknown function: evaluate all args as lend (no consumption), skip cap check
        for (const arg of expr.args) checkExpr(arg, scope, caps, env, errors);
        return { kind: "plain", mode: "unrestricted", name: "?" };
      }

      // Verify all capability requirements are satisfied in the current scope
      for (const cap of sig.caps) {
        if (!caps.has(cap)) {
          errors.push({ message: `missing capability '${cap}' required by '${expr.fn}'`, pos: expr.pos });
        }
      }

      for (let i = 0; i < sig.params.length; i++) {
        const param = sig.params[i];
        const arg = expr.args[i];
        if (!arg) {
          errors.push({ message: `not enough arguments to '${expr.fn}'`, pos: expr.pos });
          continue;
        }
        checkExpr(arg, scope, caps, env, errors);

        if (arg.kind === "var") {
          const binding = scope.get(arg.name);
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
```

- [ ] **Step 4: Run tests — expect ALL tests to pass**

```bash
npm test -- --testPathPattern=checker
```

Expected:
```
Tests: 57 passed, 57 total
```

(192 total + 6 new = 198 if running all suites. Checker suite: previous 51 + 6 new = 57.)

- [ ] **Step 5: Run full suite to confirm no regression**

```bash
npm test
```

Expected:
```
Tests: 198 passed, 198 total
```

- [ ] **Step 6: Commit**

```bash
git add src/checker.ts tests/checker.test.ts
git commit -m "feat(checker): verify capability requirements at call sites (Step 4, rule 1)"
```

---

## Task 3: `select` statement handling + integration

Implement `select` and confirm the canonical programs still pass.

**Files:**
- Modify: `src/checker.ts` (`select` case in `checkStmt`)
- Modify: `tests/checker.test.ts` (add `describe("select statement", ...)`)

- [ ] **Step 1: Write failing tests for `select`**

Add this describe block at the end of `tests/checker.test.ts`:

```typescript
describe("select statement", () => {
  it("select adds the atom to cap scope and enables a subsequent cap-requiring call", () => {
    // After 'select Read from Fs', 'Read' is in scope so read_file() can be called
    const src = `
      capability Fs
      fn read_file() using Read -> ()
      fn do_read() using Fs -> () {
        select Read from Fs
        read_file()
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("select with a source cap not in scope produces an error", () => {
    const src = `
      fn read_file() using Read -> ()
      fn do_read() -> () {
        select Read from Fs
        read_file()
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("'Fs'") && e.message.includes("select"))).toBe(true);
  });

  it("select with missing source still produces a cap error at the subsequent call", () => {
    // When 'select Read from Fs' fails (Fs not in scope), Read is NOT added.
    // The subsequent read_file() call also produces a missing-cap error.
    const src = `
      fn read_file() using Read -> ()
      fn do_read() -> () {
        select Read from Fs
        read_file()
      }
    `;
    const errors = check(parse(src, "test.fit"));
    // At least: the select error; read_file also errors because Read never got added
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("select of multiple atoms adds all of them to scope", () => {
    const src = `
      capability Fs
      fn needs_read() using Read -> ()
      fn needs_write() using Write -> ()
      fn do_both() using Fs -> () {
        select Read, Write from Fs
        needs_read()
        needs_write()
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("source cap is not consumed by select — still usable after", () => {
    // After 'select Read from Fs', Fs itself remains in scope (unrestricted)
    // So a subsequent function call requiring Fs also works
    const src = `
      capability Fs
      fn needs_fs() using Fs -> ()
      fn needs_read() using Read -> ()
      fn do_work() using Fs -> () {
        select Read from Fs
        needs_read()
        needs_fs()
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("payment.fit integration: process_payment with cap checks passes", () => {
    const src = `
      capability ChargeCard
      resource AuthToken { token_id: TokenId, cleanup: void_token }
      enum PaymentError { Declined, NetworkFail, InvalidCard, AlreadyCharged }
      fn validate_card(card: CardDetails) using Net -> Result<AuthToken, PaymentError>
      fn execute_charge(token: AuthToken, amount: Cents) using Net, ChargeCard -> Result<Receipt, PaymentError>
      fn audit_log(receipt: Receipt) using Net -> Result<(), PaymentError>
      fn process_payment(card: CardDetails, amount: Cents) using Net, ChargeCard -> Result<Receipt, PaymentError> {
        let token   = validate_card(card)?
        let receipt = execute_charge(token, amount)?
        audit_log(receipt)?
        Ok(receipt)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — expect new tests to FAIL**

```bash
npm test -- --testPathPattern=checker
```

Expected: "select adds the atom to cap scope..." FAILS because `select` is currently a no-op (atoms not added → `read_file()` still errors). The "missing source" tests may accidentally pass. Confirm at least one select test fails.

- [ ] **Step 3: Implement `select` in `checkStmt`**

In `src/checker.ts`, locate the `checkStmt` function. Find the `case "select": break;` line and replace it:

```typescript
    case "select": {
      if (!caps.has(stmt.from)) {
        errors.push({ message: `capability '${stmt.from}' not in scope for 'select'`, pos: stmt.pos });
      } else {
        // Source cap is unrestricted — not consumed. Add projected atoms to scope.
        for (const atom of stmt.atoms) caps.add(atom);
      }
      break;
    }
```

- [ ] **Step 4: Run checker tests — expect ALL to pass**

```bash
npm test -- --testPathPattern=checker
```

Expected:
```
Tests: 63 passed, 63 total
```

(57 from Task 2 + 6 new = 63.)

- [ ] **Step 5: Run full suite including canonical integration tests**

```bash
npm test
```

Expected:
```
Tests: 204 passed, 204 total
```

The existing payment.fit and smtp.fit integration tests (which call `check(parse(...))` against the canonical files) must still produce zero errors. The canonical programs have correct `using` clauses so all cap requirements are satisfied.

- [ ] **Step 6: Commit**

```bash
git add src/checker.ts tests/checker.test.ts
git commit -m "feat(checker): implement select atom projection and integration tests (Step 4 complete)"
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|-------------|------|
| 1. `using Cap` satisfied at call site | Task 2 |
| 2. Strict resolution (exactly one cap of a type) | Set deduplication — inherent; no extra code needed |
| 3. `select Read from Fs` adds Read; Fs not consumed | Task 3 |
| 4. No-`using` function cannot call cap function | Falls out of requirement 1 (empty CapScope → missing cap error) |

All four requirements covered.

### Placeholder scan

No TBDs, no "add appropriate handling" phrases, no missing code blocks.

### Type consistency

- `CapScope = Set<string>` — used consistently throughout
- `caps.has(cap)` / `caps.add(atom)` — standard Set API
- `errors.push({ message: ..., pos: expr.pos })` — matches `CheckError` type
- `stmt.from`, `stmt.atoms` — match `Stmt.select` AST shape from `src/ast.ts`
- `sig.caps` — matches `FunctionSig.caps: string[]` from `src/types.ts`

### Edge cases

- `drop` built-in: no cap check (handled first before sig lookup)
- Unknown functions: skip cap check (matches linearity behavior)
- Multiple caps missing: one error per missing cap (iterating `sig.caps`)
- `select` with invalid source: atoms NOT added — downstream call also errors (tested)
- Source cap persists after `select` (unrestricted — Set, not consumed)
