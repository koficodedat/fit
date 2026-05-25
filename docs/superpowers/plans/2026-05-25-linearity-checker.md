# Linearity Checker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `src/checker.ts` — the linearity + ownership + typestate checker for FIT, covering all seven rules in CLAUDE.md Step 3.

**Architecture:** Pure functions (no class) accumulating errors into a `CheckError[]` array passed through the call chain. A `Scope = Map<string, Binding>` tracks binding liveness per function body. Scope is forked (cloned) for branches; loop bodies are checked in a clone and their typestate snapshot is compared before propagating back.

**Tech Stack:** TypeScript (strict), Jest/ts-jest. Builds on `src/types.ts` (`buildTypeEnv`, `FitType`) and `src/ast.ts` (`Stmt`, `Expr`, `Pos`).

---

## Pre-read (required before any task)

Read these files before starting. Do NOT re-read between tasks — the code you write IS the truth.

- `src/ast.ts` — all AST node types
- `src/types.ts` — `FitType`, `TypeEnv`, `FunctionSig`, `ResolvedParam`, `buildTypeEnv`
- `tests/payment.fit` and `tests/smtp.fit` — the two canonical programs that MUST pass
- `CLAUDE.md` — escalation rules; Step 3 rules are listed there
- `docs/FIT-SYNTAX.md` §3.5 (lend/move inference), §4 (bindings), §5 (control flow)

### Known gaps to carry in (do not fix, just know)

1. **Lend-gap**: `close(c: SmtpConn<Closing>)` and `execute_charge(token, ...)` are inferred as `lend` by the return-type heuristic because their resource param doesn't appear in the return type. They semantically consume, but the checker sees them as lend. Auto-cleanup fires at scope exit instead of at the call site. The canonical programs MUST still pass — do not "fix" the inference rule.
2. **Records are plain**: record types with resource-typed fields resolve as `kind: "plain", mode: "unrestricted"`. Do not attempt transitively-linear records.
3. **Signature-only fns**: `decl.body === null` for signature-only functions. Guard before checking.

---

## File structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/checker.ts` | Create | Linearity checker — all rules |
| `tests/checker.test.ts` | Create | Unit + integration tests for checker |

---

## Task 1: Skeleton — types, entry point, stubs

**Files:**
- Create: `src/checker.ts`
- Create: `tests/checker.test.ts`

- [ ] **Step 1: Write failing tests for skeleton exports**

```typescript
// tests/checker.test.ts
import { check, CheckError } from "../src/checker";
import { parse } from "../src/parser";

describe("checker skeleton", () => {
  it("check() exists and returns an array", () => {
    const errors = check(parse("", "test.fit"));
    expect(Array.isArray(errors)).toBe(true);
  });

  it("empty program produces no errors", () => {
    expect(check(parse("", "test.fit"))).toEqual([]);
  });

  it("program with only capability decl produces no errors", () => {
    expect(check(parse("capability Net", "test.fit"))).toEqual([]);
  });

  it("program with only resource decl produces no errors", () => {
    const src = `resource Foo { cleanup: drop_foo }`;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("program with signature-only fn produces no errors", () => {
    const src = `fn make_foo() -> Foo`;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("CheckError has message and pos fields", () => {
    // Structural test — just verifying the type shape compiles
    const e: CheckError = { message: "test", pos: { line: 1, col: 1 } };
    expect(e.message).toBe("test");
    expect(e.pos.line).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx jest tests/checker.test.ts
```

Expected: FAIL — `Cannot find module '../src/checker'`

- [ ] **Step 3: Write the skeleton implementation**

```typescript
// src/checker.ts
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
  // stub — tasks 2–6 fill this in
  void stmt; void scope; void env; void errors;
}

function checkExpr(expr: Expr, scope: Scope, env: TypeEnv, errors: CheckError[]): FitType {
  // stub — tasks 2–3 fill this in
  void expr; void scope; void env; void errors;
  return { kind: "unit", mode: "unrestricted" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx jest tests/checker.test.ts
```

Expected: 6 passing

- [ ] **Step 5: Commit**

```bash
git add src/checker.ts tests/checker.test.ts
git commit -m "feat(checker): skeleton — CheckError type, check() entry point, stubs"
```

---

## Task 2: Variable usage and move tracking

Variables are the simplest expressions. Linear owned bindings are consumed (moved) when passed as move params — but `checkExpr` for `var` only READS; consumption happens at the call site. Here we handle: reading a var, detecting use-after-move, and the simple expression-statement case.

**Files:**
- Modify: `src/checker.ts`
- Modify: `tests/checker.test.ts`

- [ ] **Step 1: Write failing tests for var + move tracking**

Add these inside `tests/checker.test.ts`, after the skeleton tests:

```typescript
describe("variable usage and move tracking", () => {
  it("reading an unrestricted variable produces no error", () => {
    const src = `
      fn make_s() -> String
      fn use_s(s: String) -> ()
      fn test() -> () {
        let s = make_s()
        use_s(s)
        use_s(s)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("reading an undefined variable produces an error", () => {
    const src = `
      fn use_s(s: String) -> ()
      fn test() -> () {
        use_s(ghost)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toContain("ghost");
  });

  it("use-after-move on a linear resource produces an error", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn take_foo(f: Foo) -> ()
      fn test() -> () {
        let f = make_foo()
        take_foo(f)
        take_foo(f)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some(e => e.message.includes("already been moved"))).toBe(true);
    expect(errors.some(e => e.message.includes("'f'"))).toBe(true);
  });

  it("unit_val expression produces no error", () => {
    const src = `fn test() -> () { () }`;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("Ok() wrapping an unrestricted value produces no error", () => {
    const src = `
      fn test() -> Result<(), String> {
        Ok(())
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("Err() wrapping an unrestricted value produces no error", () => {
    const src = `
      fn test() -> Result<(), String> {
        Err(())
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx jest tests/checker.test.ts --testNamePattern "variable usage"
```

Expected: FAIL — use-after-move test passes trivially (stub returns no errors), undefined var test also passes trivially.

- [ ] **Step 3: Implement checkExpr for var/unit_val/ok/err, and checkStmt for expr**

Replace the stub implementations in `src/checker.ts`:

```typescript
// Replace the checkStmt stub with:
function checkStmt(stmt: Stmt, scope: Scope, env: TypeEnv, errors: CheckError[]): void {
  switch (stmt.kind) {
    case "expr":
      checkExpr(stmt.expr, scope, env, errors);
      break;
    // remaining cases filled in tasks 4–6
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
}

// Replace the checkExpr stub with:
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

    // call and try filled in tasks 3–4
    case "call":
    case "try":
      return { kind: "plain", mode: "unrestricted", name: "?" };

    default: {
      const _exhaustive: never = expr;
      return { kind: "unit", mode: "unrestricted" };
    }
  }
}

// Add consumeBinding after checkExpr:
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
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx jest tests/checker.test.ts
```

Expected: 12 passing (6 skeleton + 6 variable)

- [ ] **Step 5: Commit**

```bash
git add src/checker.ts tests/checker.test.ts
git commit -m "feat(checker): variable usage — var/unit_val/ok/err exprs, use-after-move detection"
```

---

## Task 3: Function calls — typestate verification + lend/move

This is the heart of the checker. When calling `f(arg)`, the checker must:
- Verify arg's current typestate matches the param's expected typestate (if both are resources with typestate)
- Apply move (mark binding consumed) or lend (leave binding intact) based on `sig.params[i].mode`
- Handle unknown functions gracefully (treat all args as lend)
- Handle `drop` as a built-in consuming sink

**Files:**
- Modify: `src/checker.ts`
- Modify: `tests/checker.test.ts`

- [ ] **Step 1: Write failing tests for call expressions**

Add after the variable usage tests:

```typescript
describe("function calls", () => {
  it("lend call does not consume the binding", () => {
    // send_message lends c (SmtpConn<Ready> not in return type)
    const src = `
      resource SmtpConn<S> { cleanup: tcp_force_close }
      fn send_message(c: SmtpConn<Ready>, msg: String) -> Result<(), String>
      fn test(c: SmtpConn<Ready>) -> () {
        send_message(c, ())
        send_message(c, ())
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("move call consumes the binding — second use is use-after-move", () => {
    const src = `
      resource Tok { cleanup: drop_tok }
      fn make_tok() -> Tok
      fn take_tok(t: Tok) -> ()
      fn test() -> () {
        let t = make_tok()
        take_tok(t)
        take_tok(t)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("already been moved"))).toBe(true);
  });

  it("call with wrong typestate produces an error", () => {
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn greet(c: Conn<Fresh>) -> Conn<Greeted>
      fn test(c: Conn<Greeted>) -> () {
        greet(c)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("typestate"))).toBe(true);
    expect(errors.some(e => e.message.includes("Greeted"))).toBe(true);
    expect(errors.some(e => e.message.includes("Fresh"))).toBe(true);
  });

  it("call with correct typestate produces no error", () => {
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn greet(c: Conn<Fresh>) -> Result<Conn<Greeted>, String>
      fn test(c: Conn<Fresh>) -> Result<Conn<Greeted>, String> {
        greet(c)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("call to unknown function does not consume its args", () => {
    // ext_fn is not declared — treat as lend, no consumption
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn take_foo(f: Foo) -> ()
      fn test() -> () {
        let f = make_foo()
        ext_fn(f)
        take_foo(f)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("drop() consumes the binding", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn test() -> () {
        let f = make_foo()
        drop(f)
        drop(f)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("already been moved"))).toBe(true);
  });

  it("lend param cannot be consumed by a move call", () => {
    // send_message lends c; inside its body we cannot pass c to a move fn
    // (this tests owned=false enforcement)
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn take_conn(c: Conn<Ready>) -> ()
      fn test(c: Conn<Ready>) -> () {
        take_conn(c)
        take_conn(c)
      }
    `;
    // take_conn takes Conn<Ready> as move; c is a lend param (Conn<Ready> not in -> ())
    // Wait — test() has return type () and c: Conn<Ready>. Conn<Ready> not in return type.
    // So c is inferred as lend (owned=false).
    // take_conn(c) first call: param mode is move (Conn<Ready> not in take_conn return type).
    // consumeBinding("c") → owned=false → error "cannot move borrowed value"
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("borrowed"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx jest tests/checker.test.ts --testNamePattern "function calls"
```

Expected: Most FAIL (call stub returns unrestricted, typestate checks not implemented).

- [ ] **Step 3: Implement checkExpr for `call` and add cloneScope helper**

Replace the `case "call":` stub in `checkExpr` and add `cloneScope`:

```typescript
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
            binding.type_.kind === "resource"  && !binding.moved
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

Add `cloneScope` after `consumeBinding`:

```typescript
function cloneScope(scope: Scope): Scope {
  const clone: Scope = new Map();
  for (const [k, v] of scope) {
    clone.set(k, { ...v });
  }
  return clone;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx jest tests/checker.test.ts
```

Expected: 19 passing (12 previous + 7 call tests)

- [ ] **Step 5: Commit**

```bash
git add src/checker.ts tests/checker.test.ts
git commit -m "feat(checker): call expressions — typestate verification, lend/move application, drop built-in"
```

---

## Task 4: let binding, rebind, and the `?` operator

`let name = expr` evaluates `expr` and adds a new owned binding. `rebind name = expr` evaluates `expr` and replaces the binding (old value gets auto-cleaned if linear; no checker error). `expr?` requires the inner expr to be a Result; on the happy path it unwraps to the Ok type; on the error path auto-cleanup fires for still-owned linears (the checker does not need to model this — cleanup always fires automatically in FIT).

**Files:**
- Modify: `src/checker.ts`
- Modify: `tests/checker.test.ts`

- [ ] **Step 1: Write failing tests for let/rebind/try**

```typescript
describe("let, rebind, and try", () => {
  it("let binding makes the value available in scope", () => {
    const src = `
      fn make_s() -> String
      fn use_s(s: String) -> ()
      fn test() -> () {
        let s = make_s()
        use_s(s)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("let creates an owned binding (linear value gets cleanup on scope exit)", () => {
    // Just verifying a let-bound linear can be held without error
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn test() -> () {
        let f = make_foo()
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("let-shadowing — old binding consumed by call before shadowing", () => {
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn greet(c: Conn<Fresh>) -> Result<Conn<Greeted>, String>
      fn test(c: Conn<Fresh>) -> Result<Conn<Greeted>, String> {
        let c = greet(c)?
        Ok(c)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("rebind works for plain unrestricted values", () => {
    const src = `
      fn next_val(x: String) -> String
      fn test() -> () {
        let mut x = next_val(())
        x = next_val(x)
        x = next_val(x)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("try unwraps Result to Ok type", () => {
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn greet(c: Conn<Fresh>) -> Result<Conn<Greeted>, String>
      fn test(c: Conn<Fresh>) -> Result<Conn<Greeted>, String> {
        let c = greet(c)?
        Ok(c)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("try on non-Result type produces an error", () => {
    const src = `
      fn make_s() -> String
      fn test() -> () {
        make_s()?
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("non-Result"))).toBe(true);
  });

  it("? on each step of a typestate chain succeeds without errors", () => {
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn connect() -> Result<Conn<Fresh>, String>
      fn greet(c: Conn<Fresh>) -> Result<Conn<Greeted>, String>
      fn auth(c: Conn<Greeted>) -> Result<Conn<Ready>, String>
      fn test() -> Result<Conn<Ready>, String> {
        let c = connect()?
        let c = greet(c)?
        let c = auth(c)?
        Ok(c)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx jest tests/checker.test.ts --testNamePattern "let, rebind"
```

Expected: Most FAIL (let/rebind/try stubs do nothing useful).

- [ ] **Step 3: Implement let, rebind, and try in checkStmt/checkExpr**

Replace the `case "let":`, `case "rebind":` stubs in `checkStmt`, and `case "try":` stub in `checkExpr`:

```typescript
// In checkStmt switch:
    case "let": {
      const initType = checkExpr(stmt.init, scope, env, errors);
      // If there's already a binding with this name, auto-cleanup fires for old value — not an error.
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
```

```typescript
// In checkExpr switch, replace case "try":
    case "try": {
      const innerType = checkExpr(expr.expr, scope, env, errors);
      if (innerType.kind !== "result") {
        errors.push({ message: `'?' applied to non-Result type`, pos: expr.pos });
        return { kind: "plain", mode: "unrestricted", name: "?" };
      }
      // Error path: still-owned linears get auto-cleaned by FIT runtime — no checker action needed.
      return innerType.ok;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx jest tests/checker.test.ts
```

Expected: 26 passing (19 previous + 7 let/rebind/try tests)

- [ ] **Step 5: Commit**

```bash
git add src/checker.ts tests/checker.test.ts
git commit -m "feat(checker): let/rebind/try — binding creation, auto-cleanup acceptance, ? unwrapping"
```

---

## Task 5: Branch exhaustiveness — if and match

For `if` and `match`, the checker forks the scope into a clone per branch, checks each branch, then merges: any linear owned binding that is moved in one branch must be moved in ALL branches, or it's an error. If it's moved in none, it remains owned after the join point. Pattern bindings in `match` arms are added as plain-unrestricted (PoC limitation: we don't type-check payload types).

**Files:**
- Modify: `src/checker.ts`
- Modify: `tests/checker.test.ts`

- [ ] **Step 1: Write failing tests for branch exhaustiveness**

```typescript
describe("branch exhaustiveness", () => {
  it("if where linear is consumed in both branches — no error", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn use_foo(f: Foo) -> ()
      fn cond() -> String
      fn test() -> () {
        let f = make_foo()
        if cond() {
          use_foo(f)
        } else {
          use_foo(f)
        }
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("if where linear is consumed in only one branch — error", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn use_foo(f: Foo) -> ()
      fn cond() -> String
      fn test() -> () {
        let f = make_foo()
        if cond() {
          use_foo(f)
        } else {
          ()
        }
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("all branches"))).toBe(true);
    expect(errors.some(e => e.message.includes("'f'"))).toBe(true);
  });

  it("if where linear is consumed in neither branch — no error (auto-cleanup fires at scope exit)", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn cond() -> String
      fn test() -> () {
        let f = make_foo()
        if cond() {
          ()
        } else {
          ()
        }
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("match where linear is consumed in all arms — no error", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      enum Choice { A, B }
      fn make_foo() -> Foo
      fn use_foo(f: Foo) -> ()
      fn get_choice() -> Choice
      fn test() -> () {
        let f = make_foo()
        match get_choice() {
          A => use_foo(f),
          B => use_foo(f),
        }
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("match where linear is consumed in only one arm — error", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      enum Choice { A, B }
      fn make_foo() -> Foo
      fn use_foo(f: Foo) -> ()
      fn get_choice() -> Choice
      fn test() -> () {
        let f = make_foo()
        match get_choice() {
          A => use_foo(f),
          B => (),
        }
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("all branches"))).toBe(true);
  });

  it("pattern bindings in match arms are accessible", () => {
    const src = `
      enum Option { None, Some(String) }
      fn use_s(s: String) -> ()
      fn get_opt() -> Option
      fn test() -> () {
        match get_opt() {
          None       => (),
          Some(val)  => use_s(val),
        }
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx jest tests/checker.test.ts --testNamePattern "branch exhaustiveness"
```

Expected: FAIL — if/match stubs do nothing (no scoping, no consistency check).

- [ ] **Step 3: Implement mergeScopes helper and if/match in checkStmt**

Add `mergeScopes` after `cloneScope`:

```typescript
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
```

Replace the `case "if":` and `case "match":` stubs in `checkStmt`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx jest tests/checker.test.ts
```

Expected: 32 passing (26 previous + 6 branch tests)

- [ ] **Step 5: Commit**

```bash
git add src/checker.ts tests/checker.test.ts
git commit -m "feat(checker): branch exhaustiveness — if/match scope forking, mergeScopes consistency check"
```

---

## Task 6: Loop typestate invariant, break, and select

A `loop` body is checked in a cloned scope. After checking, the checker compares the typestate of each resource binding before vs. after the loop body. If any changed, it's a compile error with the message specified in CLAUDE.md. Moves made inside the loop body are propagated back to the outer scope. `break` and `select` require no action for the linearity checker.

**Files:**
- Modify: `src/checker.ts`
- Modify: `tests/checker.test.ts`

- [ ] **Step 1: Write failing tests for loop invariant**

```typescript
describe("loop typestate invariant", () => {
  it("plain loop with no typestate change — no error", () => {
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn send(c: Conn<Ready>, msg: String) -> Result<(), String>
      fn next_msg(x: String) -> String
      fn deliver(c: Conn<Ready>) -> () {
        let mut msgs = ()
        loop {
          send(c, msgs)?
          msgs = next_msg(msgs)
          break
        }
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("loop that would change typestate — error", () => {
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn greet(c: Conn<Fresh>) -> Result<Conn<Greeted>, String>
      fn bad_loop(c: Conn<Fresh>) -> () {
        loop {
          let c = greet(c)?
          break
        }
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("loop body changes typestate"))).toBe(true);
    expect(errors.some(e => e.message.includes("use recursion instead"))).toBe(true);
  });

  it("loop typestate error message names the binding and both states", () => {
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn greet(c: Conn<Fresh>) -> Result<Conn<Greeted>, String>
      fn bad_loop(c: Conn<Fresh>) -> () {
        loop {
          let c = greet(c)?
          break
        }
      }
    `;
    const errors = check(parse(src, "test.fit"));
    const loopErr = errors.find(e => e.message.includes("loop body changes typestate"));
    expect(loopErr).toBeDefined();
    expect(loopErr!.message).toContain("'c'");
    expect(loopErr!.message).toContain("Fresh");
    expect(loopErr!.message).toContain("Greeted");
  });

  it("break inside loop body does not produce an error", () => {
    const src = `
      fn test() -> () {
        loop {
          break
        }
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("select statement is ignored by linearity checker (Step 4 is capability)", () => {
    const src = `
      capability Fs
      fn test() -> () {
        select Read from Fs
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx jest tests/checker.test.ts --testNamePattern "loop typestate"
```

Expected: FAIL — loop stub does nothing (no snapshot, no comparison).

- [ ] **Step 3: Implement snapshotTypestates helper and loop/break/select in checkStmt**

Add `snapshotTypestates` after `mergeScopes`:

```typescript
function snapshotTypestates(scope: Scope): Map<string, string | null> {
  const snap = new Map<string, string | null>();
  for (const [name, binding] of scope) {
    if (binding.type_.kind === "resource" && !binding.moved) {
      snap.set(name, binding.type_.typeState);
    }
  }
  return snap;
}
```

Replace the `case "loop":`, `case "break":`, `case "select":` stubs in `checkStmt`:

```typescript
    case "loop": {
      const snap = snapshotTypestates(scope);
      const bodyScope = cloneScope(scope);
      checkStmts(stmt.body, bodyScope, env, errors);

      // Check typestate invariant
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
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx jest tests/checker.test.ts
```

Expected: 37 passing (32 previous + 5 loop tests)

- [ ] **Step 5: Commit**

```bash
git add src/checker.ts tests/checker.test.ts
git commit -m "feat(checker): loop typestate invariant, break, select no-op"
```

---

## Task 7: Integration — payment.fit and smtp.fit must pass

Both canonical programs must pass the checker with zero errors. These are the primary acceptance criteria for Step 3. Any failure here is an escalation-worthy finding.

**Files:**
- Modify: `tests/checker.test.ts`

- [ ] **Step 1: Write the integration tests**

Add at the bottom of `tests/checker.test.ts`:

```typescript
describe("canonical programs — integration", () => {
  const fs   = require("fs");
  const path = require("path");

  it("payment.fit produces no checker errors", () => {
    const src = fs.readFileSync(path.join(__dirname, "payment.fit"), "utf-8");
    const errors = check(parse(src, "payment.fit"));
    if (errors.length > 0) {
      console.log("payment.fit errors:", errors);
    }
    expect(errors).toEqual([]);
  });

  it("smtp.fit produces no checker errors", () => {
    const src = fs.readFileSync(path.join(__dirname, "smtp.fit"), "utf-8");
    const errors = check(parse(src, "smtp.fit"));
    if (errors.length > 0) {
      console.log("smtp.fit errors:", errors);
    }
    expect(errors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the integration tests to see current status**

```
npx jest tests/checker.test.ts --testNamePattern "canonical programs"
```

Expected: These tests may PASS on the first run if the lend-gap and auto-cleanup design are correct, or FAIL with specific errors that need investigation.

- [ ] **Step 3: If tests fail, diagnose and fix**

The most likely failure causes and their fixes:

**Failure: "value 'token' has already been moved" in payment.fit**
- Root cause: `execute_charge` is inferred as "lend" (token not in return type), so token is NOT consumed at the call. This is correct. If this error appears, `execute_charge`'s param mode is incorrectly "move". Check `buildTypeEnv` output by logging `env.functions.get("execute_charge")?.params`.

**Failure: "argument 'c' has typestate ..." in smtp.fit**
- Root cause: a typestate mismatch in one of the greet/auth/ready/quit chain. Check that the typestate in the binding after `let c = greet(c)?` matches the param expected typestate for `auth`.

**Failure: "loop body changes typestate of 'c'" in smtp.fit's deliver_batch**
- Root cause: `c` IS changing typestate inside the loop. This should not happen since `send_message` lends `c`. Check that `send_message` is correctly inferred as lend by `buildTypeEnv`.

**Failure: "linear value 'c' must be consumed on all branches" in deliver_batch's match**
- Root cause: `c` is a LEND param (owned=false). mergeScopes only checks `owned && type_.mode === "linear"`. Since owned=false for lend params, this should not fire. If it does, check that `owned` is set to `false` for lend params in `checkFn`.

For any other failure: add `console.log` to print the full errors array, read the message carefully, trace back through which statement/expression produced it, and fix the logic. Do NOT change the lend/move heuristic in `types.ts`.

- [ ] **Step 4: Run the full test suite**

```
npx jest
```

Expected: All tests pass. The count should be at least 39 (37 unit + 2 integration). The parser and types tests (131) plus checker tests = 170+.

- [ ] **Step 5: Verify line counts for the implementation record**

```bash
wc -l src/checker.ts src/parser.ts
```

Record the output. Per CLAUDE.md, the combined parser + checker line count is the answer to PoC question 1 (compared to Austral's ~600 lines). Log it in the commit message.

- [ ] **Step 6: Commit**

```bash
git add tests/checker.test.ts
git commit -m "feat(checker): integration tests — payment.fit and smtp.fit both pass the linearity checker"
```

---

## Self-review

### Spec coverage

| CLAUDE.md Rule | Task that implements it |
|----------------|------------------------|
| 1. Linear values used exactly once — use-after-move error | Task 2 (checkExpr var) + Task 3 (consumeBinding) |
| 2. Lend-vs-move enforcement per FunctionSig.params[i].mode | Task 3 (call expr, consumeBinding conditional on mode) |
| 3. Cleanup fires for still-owned values on all exit paths | Design: auto-cleanup is implicit; checker accepts still-owned at scope exit/break/?. Not a gap. |
| 4. Move-skips-cleanup | Design: moved bindings are not re-cleaned (moved=true guards consumeBinding). |
| 5. Typestate transitions via let-shadowing + typestate verification at call sites | Task 3 (typestate check in call) + Task 4 (let creates new binding with updated type) |
| 6. Loop typestate invariant | Task 6 (snapshotTypestates + comparison) |
| 7. Linear values consumed on all branches of if/match | Task 5 (mergeScopes) |

### Placeholder scan

No TBD, TODO, or incomplete sections found.

### Type consistency check

- `Binding.type_: FitType` — defined in Task 1, referenced in all tasks. Consistent.
- `consumeBinding` signature `(name, scope, errors, pos)` — defined in Task 2, called in Task 3. Consistent.
- `cloneScope` returns `Scope` — defined in Task 3, used in Tasks 5 and 6. Consistent.
- `mergeScopes(preScope, branches, errors, pos)` — defined in Task 5, called for if and match. Consistent.
- `snapshotTypestates(scope)` returns `Map<string, string | null>` — defined in Task 6. Consistent.
- Error message for loop invariant: `"loop body changes typestate of '${name}' from ${beforeState} to ${afterBind.type_.typeState}; use recursion instead"` — matches CLAUDE.md spec exactly.
- Error message for use-after-move: `"value '${name}' has already been moved"` — matches CLAUDE.md spec exactly.

### Known limitations (PoC-accepted, no escalation needed)

- **Lend-gap**: `close` and `execute_charge` are inferred as lend. Auto-cleanup fires at scope exit. Canonical programs still pass.
- **Pattern binding types**: All match arm bindings get `kind: "plain", mode: "unrestricted"`. Linear payloads from enum variants are not tracked (out of PoC scope).
- **Complex arg expressions**: Non-var arguments to move-param functions are not consumed. Only var args are tracked. Canonical programs use only var args.
- **Exhaustiveness**: Match exhaustiveness is not checked. Out of PoC scope.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-25-linearity-checker.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — Fresh subagent per task, spec compliance review, then code quality review. Fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans.

**Which approach?**
