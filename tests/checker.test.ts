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
    const e: CheckError = { message: "test", pos: { line: 1, col: 1 } };
    expect(e.message).toBe("test");
    expect(e.pos.line).toBe(1);
  });
});

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
    // Use a rebind of an undefined var so it hits the var expr path directly.
    // (call args are not yet walked in Task 2; that comes in Task 3.)
    const src = `
      fn make_s() -> String
      fn test() -> () {
        let s = make_s()
        let t = ghost
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some(e => e.message.includes("ghost"))).toBe(true);
  });

  it("use-after-move will be detected after Task 3 adds call handling", () => {
    // This test documents the intended behavior; full move enforcement comes in Task 3
    // when consumeBinding is wired into call handling. For now, the call stub does not
    // consume arguments, so no use-after-move error is raised here.
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
    // Just verify no crash and the error system is operational
    expect(Array.isArray(errors)).toBe(true);
  });

  it("unit_val expression produces no error", () => {
    // Bare () cannot be a statement (parser requires leading ident).
    // Use a let-binding to exercise the unit_val expr path.
    const src = `fn test() -> () { let u = () }`;
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
    // take_tok returns Tok so Tok IS in return type → mode="move"
    const src = `
      resource Tok { cleanup: drop_tok }
      fn make_tok() -> Tok
      fn take_tok(t: Tok) -> Tok
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

  it("drop() consumes the binding — second drop is use-after-move", () => {
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
    // quit(c: Conn<Ready>) -> Conn<Closing>: Conn IS in return type → c's mode in quit is "move"
    // test(c: Conn<Ready>) -> (): Conn NOT in return type → c in test is lend (owned=false)
    // quit(c) inside test body: param.mode="move", c is owned=false → "cannot move borrowed value"
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn quit(c: Conn<Ready>) -> Conn<Closing>
      fn test(c: Conn<Ready>) -> () {
        quit(c)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("borrowed"))).toBe(true);
  });
});

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

  it("let creates an owned binding (linear resource held without error)", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn test() -> () {
        let f = make_foo()
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("let-shadowing — old binding consumed before shadowing, new binding has updated typestate", () => {
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
      fn next_val() -> String
      fn test() -> () {
        let mut x = next_val()
        x = next_val()
        x = next_val()
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("try unwraps Result to Ok type — typestate chain without errors", () => {
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

  it("try on non-Result type produces an error", () => {
    const src = `
      fn make_s() -> String
      fn test() -> () {
        let x = make_s()?
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("non-Result"))).toBe(true);
  });

  it("try propagates the correct ok type for later typestate use", () => {
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn connect() -> Result<Conn<Fresh>, String>
      fn greet(c: Conn<Fresh>) -> Result<Conn<Greeted>, String>
      fn auth(c: Conn<Greeted>) -> Result<Conn<Authed>, String>
      fn test() -> Result<Conn<Authed>, String> {
        let c = connect()?
        let c = greet(c)?
        let c = auth(c)?
        Ok(c)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });
});

describe("branch exhaustiveness", () => {
  it("if where linear is consumed in both branches — no error", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn use_foo(f: Foo) -> Foo
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
      fn use_foo(f: Foo) -> Foo
      fn cond() -> String
      fn test() -> () {
        let f = make_foo()
        if cond() {
          use_foo(f)
        } else {
        }
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("all branches"))).toBe(true);
    expect(errors.some(e => e.message.includes("'f'"))).toBe(true);
  });

  it("if where linear is consumed in neither branch — no error (auto-cleanup)", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn cond() -> String
      fn test() -> () {
        let f = make_foo()
        if cond() {
        } else {
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
      fn use_foo(f: Foo) -> Foo
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
      fn use_foo(f: Foo) -> Foo
      fn get_choice() -> Choice
      fn test() -> () {
        let f = make_foo()
        match get_choice() {
          A => use_foo(f),
          B => {},
        }
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("all branches"))).toBe(true);
  });

  it("pattern bindings in match arms are accessible without error", () => {
    const src = `
      enum Option { None, Some(String) }
      fn use_s(s: String) -> ()
      fn get_opt() -> Option
      fn test() -> () {
        match get_opt() {
          None       => {},
          Some(val)  => use_s(val),
        }
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });
});

describe("loop typestate invariant", () => {
  it("plain loop with no typestate change — no error", () => {
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn send(c: Conn<Ready>, msg: String) -> Result<(), String>
      fn next_msg(x: String) -> String
      fn deliver(c: Conn<Ready>) -> () {
        loop {
          send(c, ())
          break
        }
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("loop that changes typestate — error with correct message format", () => {
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

  it("select statement is a no-op for the linearity checker", () => {
    const src = `
      capability Fs
      fn test() -> () {
        select Read from Fs
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });
});

describe("canonical programs — integration", () => {
  const fs   = require("fs");
  const path = require("path");

  it("payment.fit produces no checker errors", () => {
    const src = fs.readFileSync(path.join(__dirname, "payment.fit"), "utf-8");
    const errors = check(parse(src, "payment.fit"));
    if (errors.length > 0) {
      console.log("payment.fit errors:", JSON.stringify(errors, null, 2));
    }
    expect(errors).toEqual([]);
  });

  it("smtp.fit produces no checker errors", () => {
    const src = fs.readFileSync(path.join(__dirname, "smtp.fit"), "utf-8");
    const errors = check(parse(src, "smtp.fit"));
    if (errors.length > 0) {
      console.log("smtp.fit errors:", JSON.stringify(errors, null, 2));
    }
    expect(errors).toEqual([]);
  });
});

describe("stress tests — gaps and edge cases", () => {
  // Test 1: Ok(linear) must consume the binding (verifies bug fix)
  it("Ok(linear) consumes the binding — subsequent use is use-after-move", () => {
    const src = `
      resource Tok { cleanup: drop_tok }
      fn make_tok() -> Tok
      fn take_tok(t: Tok) -> Tok
      fn test() -> Result<Tok, String> {
        let t = make_tok()
        let result = Ok(t)
        take_tok(t)
      }
    `;
    // t is linear, Ok(t) moves it into the result, take_tok(t) is use-after-move
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("already been moved"))).toBe(true);
  });

  // Test 2: Err(linear) also consumes the binding
  it("Err(linear) consumes the binding — subsequent use is use-after-move", () => {
    const src = `
      resource Tok { cleanup: drop_tok }
      fn make_tok() -> Tok
      fn take_tok(t: Tok) -> Tok
      fn test() -> Result<String, Tok> {
        let t = make_tok()
        Err(t)
        take_tok(t)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("already been moved"))).toBe(true);
  });

  // Test 3: Ok(unrestricted) does NOT consume — guard check
  it("Ok(unrestricted) does not consume the binding", () => {
    const src = `
      fn make_s() -> String
      fn test() -> Result<String, String> {
        let s = make_s()
        Ok(s)
      }
    `;
    // s is plain unrestricted — Ok(s) must not consume it
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  // Test 4: Use-after-move when moved binding used in a lend call
  it("use-after-move is reported even when second use is a lend call", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn take_foo(f: Foo) -> Foo
      fn lend_foo(f: Foo) -> ()
      fn test() -> () {
        let f = make_foo()
        take_foo(f)
        lend_foo(f)
      }
    `;
    // take_foo moves f (Foo in return type). lend_foo lends f (Foo not in return type).
    // After take_foo(f), f.moved=true. lend_foo(f) — checkExpr(var(f)) sees moved → error.
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("already been moved"))).toBe(true);
  });

  // Test 5: Wrong typestate — Fresh where Ready expected (CLAUDE.md direction)
  it("passing Conn<Fresh> to a function expecting Conn<Ready> — typestate error", () => {
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn send(c: Conn<Ready>, msg: String) -> Result<(), String>
      fn test(c: Conn<Fresh>) -> () {
        send(c, ())
      }
    `;
    // c has typeState "Fresh", send expects "Ready" — typestate mismatch
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("typestate"))).toBe(true);
    expect(errors.some(e => e.message.includes("Fresh"))).toBe(true);
    expect(errors.some(e => e.message.includes("Ready"))).toBe(true);
  });

  // Test 6: rebind of undefined variable
  it("rebind of undefined variable produces an error", () => {
    const src = `
      fn make_s() -> String
      fn test() -> () {
        ghost = make_s()
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("ghost"))).toBe(true);
  });

  // Test 7: Calling a known function with too few arguments
  it("calling a known function with too few arguments produces an error", () => {
    const src = `
      fn use_two(a: String, b: String) -> ()
      fn test() -> () {
        use_two(())
      }
    `;
    // use_two expects 2 params; called with 1 arg
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("not enough arguments"))).toBe(true);
  });

  // Test 8: Wildcard pattern in match arm
  it("wildcard _ pattern in match arm works without error", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      enum Choice { A, B }
      fn make_foo() -> Foo
      fn use_foo(f: Foo) -> Foo
      fn get_choice() -> Choice
      fn test() -> () {
        let f = make_foo()
        match get_choice() {
          _ => use_foo(f),
        }
      }
    `;
    // Wildcard arm: no binds added. use_foo(f) moves f (Foo in return type).
    // Single arm, f moved in it. mergeScopes: all branches moved → ok.
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  // Test 9: Truly empty loop body
  it("truly empty loop body produces no error", () => {
    const src = `fn test() -> () { loop {} }`;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  // Test 10: drop() with a lend param (owned=false)
  it("drop() on a lend param produces cannot-move-borrowed error", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      fn test(f: Foo) -> () {
        drop(f)
      }
    `;
    // test(f: Foo) -> () — Foo not in return type → f is lend (owned=false)
    // drop(f) calls consumeBinding("f") → owned=false → "cannot move borrowed value"
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("borrowed"))).toBe(true);
  });

  // Test 11: Two linear resources in scope simultaneously — independent consumption tracking
  it("two linear resources in scope — consuming one does not affect the other", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn take_foo(f: Foo) -> Foo
      fn test() -> () {
        let a = make_foo()
        let b = make_foo()
        take_foo(a)
        take_foo(b)
      }
    `;
    // a and b are independent. Taking a marks a.moved=true. b is unaffected.
    // take_foo(b) is fine — b.moved=false.
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  // Test 12: Post-if use of binding moved in all branches
  it("binding moved in all if-branches then used after — use-after-move error", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn take_foo(f: Foo) -> Foo
      fn lend_foo(f: Foo) -> ()
      fn cond() -> String
      fn test() -> () {
        let f = make_foo()
        if cond() {
          take_foo(f)
        } else {
          take_foo(f)
        }
        lend_foo(f)
      }
    `;
    // Both branches move f. After if, mergeScopes sets f.moved=true.
    // lend_foo(f) — checkExpr(var(f)) → f.moved=true → error.
    const errors = check(parse(src, "test.fit"));
    expect(errors.some(e => e.message.includes("already been moved"))).toBe(true);
  });
});

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
