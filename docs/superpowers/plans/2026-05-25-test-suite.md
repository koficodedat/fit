# Test Suite Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `should_pass/` and `should_fail/` FIT source programs and an auto-discovering test runner that proves the checker accepts valid programs and rejects invalid ones with errors.

**Architecture:** A Jest suite (`tests/suite.test.ts`) reads all `.fit` files from `tests/should_pass/` and `tests/should_fail/` at runtime via `fs.readdirSync`, then calls `parse` + `check` on each. Should-pass files must produce zero errors; should-fail files must produce at least one error. No expected-message pinning — a non-empty error array is sufficient.

**Tech Stack:** TypeScript, Jest, Node.js `fs` module, existing `src/parser.ts` and `src/checker.ts`

---

### Task 1: Auto-discovering test runner

**Files:**
- Create: `tests/suite.test.ts`
- Create (dirs only, no content): `tests/should_pass/` `tests/should_fail/`

- [ ] **Step 1: Write the failing test runner**

```typescript
// tests/suite.test.ts
import * as fs from "fs";
import * as path from "path";
import { parse } from "../src/parser";
import { check } from "../src/checker";

const SHOULD_PASS_DIR = path.join(__dirname, "should_pass");
const SHOULD_FAIL_DIR = path.join(__dirname, "should_fail");

function fitFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(".fit")).sort();
}

describe("should_pass", () => {
  const files = fitFiles(SHOULD_PASS_DIR);
  if (files.length === 0) {
    it("placeholder — no .fit files yet", () => {});
    return;
  }
  for (const file of files) {
    it(`${file} produces no errors`, () => {
      const src = fs.readFileSync(path.join(SHOULD_PASS_DIR, file), "utf8");
      const errors = check(parse(src, file));
      expect(errors).toEqual([]);
    });
  }
});

describe("should_fail", () => {
  const files = fitFiles(SHOULD_FAIL_DIR);
  if (files.length === 0) {
    it("placeholder — no .fit files yet", () => {});
    return;
  }
  for (const file of files) {
    it(`${file} produces at least one error`, () => {
      const src = fs.readFileSync(path.join(SHOULD_FAIL_DIR, file), "utf8");
      const errors = check(parse(src, file));
      expect(errors.length).toBeGreaterThan(0);
    });
  }
});
```

- [ ] **Step 2: Create the directories**

```bash
mkdir -p tests/should_pass tests/should_fail
```

- [ ] **Step 3: Run tests — expect placeholder tests to pass**

```bash
npx jest tests/suite.test.ts --no-coverage
```

Expected: 2 placeholder tests pass (one per describe block).

- [ ] **Step 4: Commit**

```bash
git add tests/suite.test.ts tests/should_pass/.gitkeep tests/should_fail/.gitkeep
git commit -m "test(suite): add auto-discovering should_pass/should_fail runner"
```

---

### Task 2: should_pass programs

**Files:**
- Create: `tests/should_pass/lend_and_use.fit`
- Create: `tests/should_pass/typestate_chain.fit`
- Create: `tests/should_pass/plain_loop.fit`
- Create: `tests/should_pass/error_propagation.fit`

- [ ] **Step 1: Write `lend_and_use.fit`**

A resource is lent to two functions and the caller holds it throughout. Verifies that lend-mode params do not consume the binding.

```fit
resource Handle {
    conn: Socket,
    cleanup: close_handle,
}

fn borrow_read(h: Handle) -> String
fn borrow_write(h: Handle, data: String) -> ()

fn use_handle(h: Handle) -> () {
    borrow_write(h, borrow_read(h))
}
```

- [ ] **Step 2: Write `typestate_chain.fit`**

Straight-line typestate transitions: Init → Active → Closing → done. Each step requires the exact state from the previous call's return.

```fit
enum Phase { Init, Active, Closing }

resource Session<S> {
    id: SessionId,
    cleanup: abort_session,
}

enum SessionError { Timeout, AuthFailed }

fn start_session() -> Result<Session<Init>, SessionError>
fn activate(s: Session<Init>) -> Result<Session<Active>, SessionError>
fn deactivate(s: Session<Active>) -> Result<Session<Closing>, SessionError>
fn end_session(s: Session<Closing>) -> Result<(), SessionError>

fn run_session() -> Result<(), SessionError> {
    let s = start_session()?
    let s = activate(s)?
    let s = deactivate(s)?
    end_session(s)?
    Ok(())
}
```

- [ ] **Step 3: Write `plain_loop.fit`**

A loop that lends a resource each iteration without changing its typestate. Verifies the loop invariant is satisfied when typestate is stable.

```fit
enum ConnState { Ready }

resource Conn<S> {
    sock: Socket,
    cleanup: force_close,
}

fn send_msg(c: Conn<Ready>, msg: String) -> ()
fn get_msg() -> String
fn should_stop() -> String

fn send_loop(c: Conn<Ready>) -> () {
    loop {
        let msg = get_msg()
        send_msg(c, msg)
        if should_stop() {
            break
        } else {}
    }
}
```

- [ ] **Step 4: Write `error_propagation.fit`**

`?` on a fallible call propagates early exit. The resource must be fully consumed on both the success path (explicit `close`) and implicitly on error paths via FIT's auto-cleanup. Checker must accept this.

```fit
enum ConnState { Fresh, Ready }

resource Conn<S> {
    sock: Socket,
    cleanup: force_close,
}

enum NetError { Refused, Timeout }

fn connect(host: String) -> Result<Conn<Fresh>, NetError>
fn handshake(c: Conn<Fresh>) -> Result<Conn<Ready>, NetError>
fn send(c: Conn<Ready>, data: String) -> Result<(), NetError>
fn close(c: Conn<Ready>) -> ()

fn run(host: String, data: String) -> Result<(), NetError> {
    let c = connect(host)?
    let c = handshake(c)?
    send(c, data)?
    close(c)
    Ok(())
}
```

- [ ] **Step 5: Run suite — expect 4 new should_pass tests to pass**

```bash
npx jest tests/suite.test.ts --no-coverage
```

Expected output includes:
```
should_pass
  ✓ error_propagation.fit produces no errors
  ✓ lend_and_use.fit produces no errors
  ✓ plain_loop.fit produces no errors
  ✓ typestate_chain.fit produces no errors
```

- [ ] **Step 6: Commit**

```bash
git add tests/should_pass/
git commit -m "test(should_pass): add lend_and_use, typestate_chain, plain_loop, error_propagation"
```

---

### Task 3: should_fail programs

**Files:**
- Create: `tests/should_fail/use_after_move.fit`
- Create: `tests/should_fail/use_after_try.fit`
- Create: `tests/should_fail/loop_typestate.fit`
- Create: `tests/should_fail/missing_cap.fit`
- Create: `tests/should_fail/branch_not_consumed.fit`
- Create: `tests/should_fail/wrong_typestate.fit`

- [ ] **Step 1: Write `use_after_move.fit`**

Consuming a linear token twice. Second call is a use-after-move.

```fit
resource Token {
    id: TokenId,
    cleanup: revoke_token,
}

fn consume_token(t: Token) -> Token

fn test(t: Token) -> () {
    consume_token(t)
    consume_token(t)
}
```

Expected checker error: `value 't' has already been moved`

- [ ] **Step 2: Write `use_after_try.fit`**

After `auth(c, creds)?`, `c` is in a moved state (consumed by `auth`). Attempting to use `c` again is a use-after-move.

```fit
enum State { Fresh, Authed }

resource Conn<S> {
    sock: Socket,
    cleanup: force_close,
}

enum NetError { Refused }

fn auth(c: Conn<Fresh>, creds: Credentials) -> Result<Conn<Authed>, NetError>
fn send_data(c: Conn<Fresh>, data: String) -> Result<(), NetError>

fn test(c: Conn<Fresh>, creds: Credentials, data: String) -> Result<(), NetError> {
    let c2 = auth(c, creds)?
    send_data(c, data)?
    Ok(())
}
```

Expected checker error: `value 'c' has already been moved`

- [ ] **Step 3: Write `loop_typestate.fit`**

The loop body changes `c` from `Conn<Ready>` to `Conn<Closing>`. This violates the loop typestate invariant.

```fit
enum ConnState { Ready, Closing }

resource Conn<S> {
    sock: Socket,
    cleanup: force_close,
}

fn transition(c: Conn<Ready>) -> Conn<Closing>

fn test(c: Conn<Ready>) -> () {
    loop {
        let c = transition(c)
        break
    }
}
```

Expected checker error: `loop body changes typestate of 'c' from Ready to Closing`

- [ ] **Step 4: Write `missing_cap.fit`**

`pay` calls `charge` which requires `ChargeCard`, but `pay` has no `using` clause.

```fit
capability ChargeCard

fn charge(amount: Cents) using ChargeCard -> Receipt

fn pay(amount: Cents) -> Receipt {
    charge(amount)
}
```

Expected checker error: `missing capability 'ChargeCard' required by 'charge'`

- [ ] **Step 5: Write `branch_not_consumed.fit`**

`t` is linear. The `Left` branch consumes it via `use_token` + `drop`, but the `Right` branch does nothing — `t` escapes unconsumed.

```fit
resource Token {
    id: TokenId,
    cleanup: revoke_token,
}

fn make_token() -> Token
fn use_token(t: Token) -> Token

enum Choice { Left, Right }

fn get_choice() -> Choice

fn test() -> () {
    let t = make_token()
    match get_choice() {
        Left => {
            let t2 = use_token(t)
            drop(t2)
        },
        Right => {},
    }
}
```

Expected checker error: `linear value 't' must be consumed on all branches`

- [ ] **Step 6: Write `wrong_typestate.fit`**

`c` is `Conn<Fresh>` but `send_data` requires `Conn<Ready>`.

```fit
enum ConnState { Fresh, Ready }

resource Conn<S> {
    sock: Socket,
    cleanup: force_close,
}

fn get_data() -> String
fn send_data(c: Conn<Ready>, data: String) -> ()

fn test(c: Conn<Fresh>) -> () {
    send_data(c, get_data())
}
```

Expected checker error: `argument 'c' has typestate 'Fresh', expected 'Ready'`

- [ ] **Step 7: Run suite — expect all 6 should_fail tests to produce errors**

```bash
npx jest tests/suite.test.ts --no-coverage
```

Expected output includes:
```
should_fail
  ✓ branch_not_consumed.fit produces at least one error
  ✓ loop_typestate.fit produces at least one error
  ✓ missing_cap.fit produces at least one error
  ✓ use_after_move.fit produces at least one error
  ✓ use_after_try.fit produces at least one error
  ✓ wrong_typestate.fit produces at least one error
```

- [ ] **Step 8: Run full test suite — all 223 + 12 new = 235 tests must pass**

```bash
npx jest --no-coverage
```

Expected: 235 tests passing, 0 failing.

- [ ] **Step 9: Commit**

```bash
git add tests/should_fail/
git commit -m "test(should_fail): add use_after_move, use_after_try, loop_typestate, missing_cap, branch_not_consumed, wrong_typestate"
```

---

## Self-Review

**Spec coverage:**
- payment.fit and smtp.fit already pass (Steps 1–4) — covered by the existing checker.test.ts integration tests; suite.test.ts auto-discovers them if placed in should_pass/. They're not duplicated because they're already tested; placing them in should_pass/ is redundant given existing coverage. ✓
- Lend resource, caller uses after → `lend_and_use.fit` ✓
- Straight-line typestate transitions → `typestate_chain.fit` ✓
- Plain loop no typestate change → `plain_loop.fit` ✓
- Error propagation with `?` → `error_propagation.fit` ✓
- Use after move → `use_after_move.fit` ✓
- Use after `?` return → `use_after_try.fit` ✓
- Loop crosses typestate → `loop_typestate.fit` ✓
- Missing capability → `missing_cap.fit` ✓
- Linear not consumed on one branch → `branch_not_consumed.fit` ✓
- Wrong typestate at call site → `wrong_typestate.fit` ✓

**Placeholder scan:** No TBDs. All program content is complete FIT source.

**Type consistency:** `parse(src, file)` and `check(program)` signatures match `src/parser.ts` and `src/checker.ts` exports exactly.
