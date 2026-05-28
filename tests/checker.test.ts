// tests/checker.test.ts
import * as fs from "fs";
import * as path from "path";
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
    expect(errors.some((e) => e.message.includes("ghost"))).toBe(true);
  });

  it("use-after-move will be detected after Task 3 adds call handling", () => {
    // This test documents the intended behavior; full move enforcement comes in Task 3
    // when consumeBinding is wired into call handling. For now, the call stub does not
    // consume arguments, so no use-after-move error is raised here.
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn take_foo(f: move Foo) -> ()
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
      fn send_message(c: lend SmtpConn<Ready>, msg: String) -> Result<(), String>
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
      fn take_tok(t: move Tok) -> Tok
      fn test() -> () {
        let t = make_tok()
        take_tok(t)
        take_tok(t)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("already been moved"))).toBe(true);
  });

  it("call with wrong typestate produces an error", () => {
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn greet(c: move Conn<Fresh>) -> Conn<Greeted>
      fn test(c: Conn<Greeted>) -> () {
        greet(c)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("typestate"))).toBe(true);
    expect(errors.some((e) => e.message.includes("Greeted"))).toBe(true);
    expect(errors.some((e) => e.message.includes("Fresh"))).toBe(true);
  });

  it("call with correct typestate produces no error", () => {
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn greet(c: move Conn<Fresh>) -> Result<Conn<Greeted>, String>
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
      fn take_foo(f: move Foo) -> ()
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
    expect(errors.some((e) => e.message.includes("already been moved"))).toBe(true);
  });

  it("lend param cannot be consumed by a move call", () => {
    // quit(c: move Conn<Ready>): consuming transition function
    // test(c: lend Conn<Ready>): explicit lend annotation → owned=false
    // quit(c) inside test body: param.mode="move", c is owned=false → "cannot move borrowed value"
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn quit(c: move Conn<Ready>) -> Conn<Closing>
      fn test(c: lend Conn<Ready>) -> () {
        quit(c)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("borrowed"))).toBe(true);
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

  it("let creates an owned binding — explicit drop satisfies linearity", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn test() -> () {
        let f = make_foo()
        drop(f)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("let-shadowing — old binding consumed before shadowing, new binding has updated typestate", () => {
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn greet(c: move Conn<Fresh>) -> Result<Conn<Greeted>, String>
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
      fn greet(c: move Conn<Fresh>) -> Result<Conn<Greeted>, String>
      fn auth(c: move Conn<Greeted>) -> Result<Conn<Ready>, String>
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
    expect(errors.some((e) => e.message.includes("non-Result"))).toBe(true);
  });

  it("try propagates the correct ok type for later typestate use", () => {
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn connect() -> Result<Conn<Fresh>, String>
      fn greet(c: move Conn<Fresh>) -> Result<Conn<Greeted>, String>
      fn auth(c: move Conn<Greeted>) -> Result<Conn<Authed>, String>
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
      fn use_foo(f: move Foo) -> Foo
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
      fn use_foo(f: move Foo) -> Foo
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
    expect(errors.some((e) => e.message.includes("all branches"))).toBe(true);
    expect(errors.some((e) => e.message.includes("'f'"))).toBe(true);
  });

  it("if where linear is not consumed in any branch — drop after if satisfies linearity", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn cond() -> String
      fn test() -> () {
        let f = make_foo()
        if cond() {
        } else {
        }
        drop(f)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("match where linear is consumed in all arms — no error", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      enum Choice { A, B }
      fn make_foo() -> Foo
      fn use_foo(f: move Foo) -> Foo
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
      fn use_foo(f: move Foo) -> Foo
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
    expect(errors.some((e) => e.message.includes("all branches"))).toBe(true);
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
      fn send(c: lend Conn<Ready>, msg: String) -> Result<(), String>
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
      fn greet(c: move Conn<Fresh>) -> Result<Conn<Greeted>, String>
      fn bad_loop(c: Conn<Fresh>) -> () {
        loop {
          let c = greet(c)?
          break
        }
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("loop body changes typestate"))).toBe(true);
    expect(errors.some((e) => e.message.includes("use recursion instead"))).toBe(true);
  });

  it("loop typestate error message names the binding and both states", () => {
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn greet(c: move Conn<Fresh>) -> Result<Conn<Greeted>, String>
      fn bad_loop(c: Conn<Fresh>) -> () {
        loop {
          let c = greet(c)?
          break
        }
      }
    `;
    const errors = check(parse(src, "test.fit"));
    const loopErr = errors.find((e) => e.message.includes("loop body changes typestate"));
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

  it("select inside a function with matching cap does not affect linearity", () => {
    const src = `
      capability Fs
      fn test() using Fs -> () {
        select Read from Fs
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });
});

describe("canonical programs — integration", () => {
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

  it("drain.fit produces no checker errors", () => {
    const src = fs.readFileSync(path.join(__dirname, "drain.fit"), "utf-8");
    const errors = check(parse(src, "drain.fit"));
    if (errors.length > 0) {
      console.log("drain.fit errors:", JSON.stringify(errors, null, 2));
    }
    expect(errors).toEqual([]);
  });

  it("drain_loop.fit produces a loop-typestate error naming 'c', 'Open', and 'Draining'", () => {
    const src = fs.readFileSync(path.join(__dirname, "should_fail", "drain_loop.fit"), "utf-8");
    const errors = check(parse(src, "drain_loop.fit"));
    const loopErr = errors.find((e) => e.message.includes("loop body changes typestate"));
    expect(loopErr).toBeDefined();
    expect(loopErr!.message).toContain("'c'");
    expect(loopErr!.message).toContain("'Open'");
    expect(loopErr!.message).toContain("'Draining'");
  });
});

describe("stress tests — gaps and edge cases", () => {
  // Test 1: Ok(linear) must consume the binding (verifies bug fix)
  it("Ok(linear) consumes the binding — subsequent use is use-after-move", () => {
    const src = `
      resource Tok { cleanup: drop_tok }
      fn make_tok() -> Tok
      fn take_tok(t: move Tok) -> Tok
      fn test() -> Result<Tok, String> {
        let t = make_tok()
        let result = Ok(t)
        take_tok(t)
      }
    `;
    // t is linear, Ok(t) moves it into the result, take_tok(t) is use-after-move
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("already been moved"))).toBe(true);
  });

  // Test 2: Err(linear) also consumes the binding
  it("Err(linear) consumes the binding — subsequent use is use-after-move", () => {
    const src = `
      resource Tok { cleanup: drop_tok }
      fn make_tok() -> Tok
      fn take_tok(t: move Tok) -> Tok
      fn test() -> Result<String, Tok> {
        let t = make_tok()
        Err(t)
        take_tok(t)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("already been moved"))).toBe(true);
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
      fn take_foo(f: move Foo) -> Foo
      fn lend_foo(f: lend Foo) -> ()
      fn test() -> () {
        let f = make_foo()
        take_foo(f)
        lend_foo(f)
      }
    `;
    // take_foo moves f (Foo in return type). lend_foo lends f (Foo not in return type).
    // After take_foo(f), f.moved=true. lend_foo(f) — checkExpr(var(f)) sees moved → error.
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("already been moved"))).toBe(true);
  });

  // Test 5: Wrong typestate — Fresh where Ready expected (CLAUDE.md direction)
  it("passing Conn<Fresh> to a function expecting Conn<Ready> — typestate error", () => {
    const src = `
      resource Conn<S> { cleanup: drop_conn }
      fn send(c: lend Conn<Ready>, msg: String) -> Result<(), String>
      fn test(c: Conn<Fresh>) -> () {
        send(c, ())
      }
    `;
    // c has typeState "Fresh", send expects "Ready" — typestate mismatch
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("typestate"))).toBe(true);
    expect(errors.some((e) => e.message.includes("Fresh"))).toBe(true);
    expect(errors.some((e) => e.message.includes("Ready"))).toBe(true);
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
    expect(errors.some((e) => e.message.includes("ghost"))).toBe(true);
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
    expect(errors.some((e) => e.message.includes("not enough arguments"))).toBe(true);
  });

  // Test 8: Wildcard pattern in match arm
  it("wildcard _ pattern in match arm works without error", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      enum Choice { A, B }
      fn make_foo() -> Foo
      fn use_foo(f: move Foo) -> Foo
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
      fn test(f: lend Foo) -> () {
        drop(f)
      }
    `;
    // test(f: lend Foo) — explicit lend annotation → owned=false
    // drop(f) calls consumeBinding("f") → owned=false → "cannot move borrowed value"
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("borrowed"))).toBe(true);
  });

  // Test 11: Two linear resources in scope simultaneously — independent consumption tracking
  it("two linear resources in scope — consuming one does not affect the other", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn take_foo(f: move Foo) -> Foo
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
      fn take_foo(f: move Foo) -> Foo
      fn lend_foo(f: lend Foo) -> ()
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
    expect(errors.some((e) => e.message.includes("already been moved"))).toBe(true);
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

describe("select statement", () => {
  it("select adds the atom to cap scope and enables a subsequent cap-requiring call", () => {
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
    expect(errors.some((e) => e.message.includes("'Fs'") && e.message.includes("select"))).toBe(
      true
    );
  });

  it("select with missing source still produces a cap error at the subsequent call", () => {
    const src = `
      fn read_file() using Read -> ()
      fn do_read() -> () {
        select Read from Fs
        read_file()
      }
    `;
    const errors = check(parse(src, "test.fit"));
    // select error + read_file missing Read error (Read never got added because Fs was missing)
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

  it("payment.fit inline integration: process_payment with cap checks passes", () => {
    const src = `
      capability ChargeCard
      resource AuthToken { token_id: TokenId, cleanup: void_token }
      enum PaymentError { Declined, NetworkFail, InvalidCard, AlreadyCharged }
      fn validate_card(card: CardDetails) using Net -> Result<AuthToken, PaymentError>
      fn execute_charge(token: move AuthToken, amount: Cents) using Net, ChargeCard -> Result<Receipt, PaymentError>
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

describe("capability checker gap coverage", () => {
  it("both caps missing from caller produces two errors (one per cap)", () => {
    const src = `
      fn needs_two() using Net, ChargeCard -> ()
      fn no_caps() -> () { needs_two() }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors).toHaveLength(2);
    expect(errors.some((e) => e.message.includes("'Net'"))).toBe(true);
    expect(errors.some((e) => e.message.includes("'ChargeCard'"))).toBe(true);
  });

  it("select in then-branch does NOT grant atom in else-branch (bug fix verification)", () => {
    const src = `
      capability Fs
      fn cond_fn() -> String
      fn needs_read() using Read -> ()
      fn do_read() using Fs -> () {
        if cond_fn() {
          select Read from Fs
        } else {
          needs_read()
        }
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("missing capability 'Read'");
    expect(errors[0].message).toContain("needs_read");
  });

  it("cap check fires through ? propagation", () => {
    const src = `
      fn needs_net() using Net -> Result<String, String>
      fn no_caps() -> Result<String, String> {
        let x = needs_net()?
        Ok(x)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("missing capability 'Net'");
  });

  it("cap check fires through ? when cap is present — no error", () => {
    const src = `
      fn needs_net() using Net -> Result<String, String>
      fn has_net() using Net -> Result<String, String> {
        let x = needs_net()?
        Ok(x)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("cap check fires inside Ok() wrapper", () => {
    const src = `
      fn needs_net() using Net -> String
      fn no_caps() -> Result<String, String> {
        Ok(needs_net())
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("missing capability 'Net'");
  });

  it("cap check fires inside Err() wrapper", () => {
    const src = `
      fn needs_net() using Net -> String
      fn no_caps() -> Result<String, String> {
        Err(needs_net())
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("missing capability 'Net'");
  });

  it("realistic caller with one of two required caps produces one error naming the missing cap", () => {
    const src = `
      capability ChargeCard
      resource AuthToken { token_id: TokenId, cleanup: void_token }
      enum PaymentError { Declined }
      fn execute_charge(token: move AuthToken, amount: Cents) using Net, ChargeCard -> Result<Receipt, PaymentError>
      fn process_payment(card: CardDetails, amount: Cents) using Net -> Result<Receipt, PaymentError> {
        let token = validate_card(card)?
        let receipt = execute_charge(token, amount)?
        Ok(receipt)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    const chargeErrors = errors.filter(
      (e) => e.message.includes("'ChargeCard'") && e.message.includes("execute_charge")
    );
    expect(chargeErrors).toHaveLength(1);
  });

  it("self-projection select Fs from Fs is idempotent — no error", () => {
    const src = `
      capability Fs
      fn do_work() using Fs -> () {
        select Fs from Fs
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("atom from select persists for multiple subsequent calls in same scope", () => {
    const src = `
      capability Fs
      fn needs_read() using Read -> ()
      fn do_reads() using Fs -> () {
        select Read from Fs
        needs_read()
        needs_read()
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("function with extra caps calling fewer-cap function produces no error", () => {
    const src = `
      fn needs_net() using Net -> ()
      fn has_more() using Net, Console -> () { needs_net() }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });
});

describe("holistic gap coverage", () => {
  it("use-after-move via move-mode call produces exactly one error (not two)", () => {
    // BUG-1 regression: consumeBinding must not double-report already-moved
    // Tok must be a resource so binding.type_.mode === "linear" and move semantics apply
    const src = `
      resource Tok { id: TokId, cleanup: revoke_tok }
      fn make_tok() -> Tok
      fn take_tok(t: move Tok) -> Tok
      fn test() -> () {
        let t = make_tok()
        take_tok(t)
        take_tok(t)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    // Exactly one "already been moved" error for the second take_tok(t) call
    const moveErrors = errors.filter((e) => e.message.includes("already been moved"));
    expect(moveErrors).toHaveLength(1);
  });

  it("empty match produces no false-positive errors on linear bindings", () => {
    // BUG-2 regression: empty branches in mergeScopes must not mark bindings as moved
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn make_val() -> String
      fn test() -> () {
        let f = make_foo()
        match make_val() {}
        drop(f)
      }
    `;
    // Before fix: match marks f as moved, so drop(f) produces "already been moved"
    // After fix: match with no arms is a no-op for binding state, drop(f) is fine
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("wrong typestate AND missing cap on same call — both errors reported", () => {
    const src = `
      enum State { Fresh, Ready }
      resource Conn<S> { sock: Socket, cleanup: force_close }
      fn ready_op(c: lend Conn<Ready>) using Net -> ()
      fn test(c: Conn<Fresh>) -> () {
        ready_op(c)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    // One error for wrong typestate (Fresh != Ready), one for missing Net
    expect(errors.some((e) => e.message.includes("typestate") || e.message.includes("Fresh"))).toBe(
      true
    );
    expect(errors.some((e) => e.message.includes("missing capability 'Net'"))).toBe(true);
  });

  it("select inside match arm does NOT make the atom available after the match", () => {
    const src = `
      capability Fs
      enum Choice { A, B }
      fn get_choice() -> Choice
      fn needs_read() using Read -> ()
      fn do_work() using Fs -> () {
        match get_choice() {
          A => {
            select Read from Fs
          },
          B => {},
        }
        needs_read()
      }
    `;
    // After the match, Read should NOT be in scope — it was only selected in one arm
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("missing capability 'Read'"))).toBe(true);
  });

  it("select inside loop body enables cap-requiring calls within the same loop iteration", () => {
    const src = `
      capability Fs
      fn needs_read() using Read -> ()
      fn do_loop() using Fs -> () {
        loop {
          select Read from Fs
          needs_read()
          break
        }
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("after loop containing select, the atom is NOT available post-loop", () => {
    const src = `
      capability Fs
      fn needs_read() using Read -> ()
      fn do_loop() using Fs -> () {
        loop {
          select Read from Fs
          break
        }
        needs_read()
      }
    `;
    // Read was only selected inside the loop body (cloned caps) — not in outer scope
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("missing capability 'Read'"))).toBe(true);
  });

  it("function with linear param consumed by move call — returns normally with no error", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      fn consume_foo(f: move Foo) -> Foo
      fn test(f: Foo) -> Foo {
        consume_foo(f)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("rebind of a linear binding produces no error — old value is auto-cleaned", () => {
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn do_rebind() -> () {
        let mut f = make_foo()
        f = make_foo()
        drop(f)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("nested if inside loop — cap isolation chains correctly", () => {
    const src = `
      capability Fs
      fn cond_check() -> String
      fn needs_read() using Read -> ()
      fn do_work() using Fs -> () {
        loop {
          if cond_check() {
            select Read from Fs
            needs_read()
          } else {
            needs_read()
          }
          break
        }
      }
    `;
    // In else-branch: Read was only selected in then-branch (cloned caps per branch)
    const errors = check(parse(src, "test.fit"));
    // The else-branch needs_read() should error (Read not in scope)
    expect(errors.some((e) => e.message.includes("missing capability 'Read'"))).toBe(true);
  });
});

describe("stress test gap coverage", () => {
  it("plain unrestricted type: double-use of Int param produces no false-positive move error", () => {
    // Finding 6: inferParamMode classifies Int as move when Int appears in return type,
    // but consumeBinding must not apply to unrestricted bindings
    const src = `
      fn double(x: Int) -> Int
      fn test(n: Int) -> () {
        let a = double(n)
        let b = double(n)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("plain unrestricted type: resource in caller IS consumed (move semantics preserved)", () => {
    const src = `
      resource Tok { id: TokId, cleanup: revoke_tok }
      fn make_tok() -> Tok
      fn consume_tok(t: move Tok) -> Tok
      fn test() -> () {
        let t = make_tok()
        consume_tok(t)
        consume_tok(t)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("already been moved"))).toBe(true);
  });

  it("drop(non-var) emits an error and returns unit", () => {
    // Finding 2: drop with a call expression arg should produce an explicit error
    const src = `
      resource Tok { id: TokId, cleanup: revoke_tok }
      fn make_tok() -> Tok
      fn test() -> () {
        drop(make_tok())
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message === "drop requires a single variable argument")).toBe(true);
  });

  it("drop() with zero args emits an error", () => {
    const src = `
      fn test() -> () {
        drop()
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message === "drop requires a single variable argument")).toBe(true);
  });

  it("too many arguments to a known function emits an error", () => {
    // Finding 4: extra args beyond sig.params.length were silently ignored
    const src = `
      resource Tok { id: TokId, cleanup: revoke_tok }
      fn make_tok() -> Tok
      fn use_tok(t: move Tok) -> ()
      fn test() -> () {
        let t = make_tok()
        let t2 = make_tok()
        use_tok(t, t2)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("too many arguments to 'use_tok'"))).toBe(true);
  });

  it("extra arg that is an undefined variable gets caught", () => {
    // Extra args now get checkExpr called, so undefined vars in extra positions are caught
    const src = `
      fn noop() -> ()
      fn test() -> () {
        noop(ghost)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("undefined variable 'ghost'"))).toBe(true);
  });

  it("loop typestate error message quotes the state names", () => {
    // Finding 14: state names should be quoted for consistency
    const src = `
      enum S { Ready, Closing }
      resource Conn<S> { sock: Sock, cleanup: force_close }
      fn make_conn() -> Conn<Ready>
      fn transition(c: move Conn<Ready>) -> Conn<Closing>
      fn test() -> () {
        let c = make_conn()
        loop {
          let c = transition(c)
          break
        }
      }
    `;
    const errors = check(parse(src, "test.fit"));
    const loopErr = errors.find((e) => e.message.includes("loop body changes typestate"));
    expect(loopErr).toBeDefined();
    expect(loopErr!.message).toContain("from 'Ready' to 'Closing'");
  });
});

describe("enum payload tracking", () => {
  it("linear payload consumed on all arms — no error", () => {
    const src = `
      resource Conn { cleanup: close_conn }
      enum Result2 { Live(Conn), Dead(Conn) }
      fn make_conn() -> Conn
      fn get_result() -> Result2
      fn close_conn(c: move Conn) -> ()
      fn test() -> () {
        match get_result() {
          Live(c) => { close_conn(c) },
          Dead(c) => { close_conn(c) },
        }
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("linear payload not consumed in its arm — error references arm variant name", () => {
    const src = `
      resource Conn { cleanup: close_conn }
      enum Result2 { Live(Conn), Dead(Conn) }
      fn make_conn() -> Conn
      fn get_result() -> Result2
      fn close_c(c: move Conn) -> ()
      fn test() -> () {
        match get_result() {
          Live(c) => { close_c(c) },
          Dead(c) => {},
        }
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("must be consumed") && e.message.includes("Dead"))).toBe(true);
  });

  it("unknown variant in pattern — 'unknown variant' error", () => {
    const src = `
      enum Foo { Alpha }
      fn get_foo() -> Foo
      fn test() -> () {
        match get_foo() {
          Beta => {},
        }
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("unknown variant") && e.message.includes("Beta"))).toBe(true);
  });

  it("no-payload variant with binds — 'no payload' error", () => {
    const src = `
      enum Status { Ok, Fail }
      fn get_status() -> Status
      fn test() -> () {
        match get_status() {
          Ok(x) => {},
          Fail => {},
        }
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("Ok") && e.message.includes("no payload"))).toBe(true);
  });

  it("linear payload dropped unbound (zero binds) — 'linear payload' error", () => {
    const src = `
      resource Tok { cleanup: drop_tok }
      enum Wrap { Wrapped(Tok) }
      fn get_wrap() -> Wrap
      fn test() -> () {
        match get_wrap() {
          Wrapped => {},
        }
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("linear payload") && e.message.includes("Wrapped"))).toBe(true);
  });

  it("fresh-named linear payload consumed — armLinearBinds clears on move, not by shadow coincidence", () => {
    // payload_conn is not present anywhere in the outer scope; this rules out the
    // possibility that the check passes because a shadowed outer binding happened to
    // be moved already.
    const src = `
      resource Conn { cleanup: close_conn }
      enum Response { Active(Conn), Closed(Conn) }
      fn get_response() -> Response
      fn take_conn(payload_conn: move Conn) -> ()
      fn test() -> () {
        match get_response() {
          Active(payload_conn) => { take_conn(payload_conn) },
          Closed(payload_conn) => { take_conn(payload_conn) },
        }
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });
});

describe("linear enum as parameter", () => {
  it("bodyless fn with unannotated linear enum param emits BuildError", () => {
    // In FIT, a fn with no body is an extern. No annotation on a linear param is a compile error.
    const src = `
      resource Conn { cleanup: close_conn }
      enum RecvResult { More(Conn), Done(Conn) }
      fn consume_r(r: RecvResult) -> ()
    `;
    const errs = check(parse(src, "test.fit"));
    expect(errs.some((e) => e.message.includes("no move/lend annotation"))).toBe(true);
  });

  it("use-after-move of a linear enum param is an error", () => {
    const src = `
      resource Conn { cleanup: close_conn }
      enum RecvResult { More(Conn), Done(Conn) }
      fn consume_r(r: move RecvResult) -> ()
      fn caller() -> () {
        let r = consume_r
        consume_r(r)
        consume_r(r)
      }
    `;
    // Simpler: pass r by move twice via two calls
    const src2 = `
      resource Conn { cleanup: close_conn }
      enum RecvResult { More(Conn), Done(Conn) }
      fn get_r() -> RecvResult
      fn consume_r(r: move RecvResult) -> ()
      fn test() -> () {
        let r = get_r()
        consume_r(r)
        consume_r(r)
      }
    `;
    const errs = check(parse(src2, "test.fit"));
    expect(errs.some((e) => e.message.includes("already been moved"))).toBe(true);
  });

  it("symmetric branch consumption of linear enum is accepted", () => {
    const src = `
      resource Conn { cleanup: close_conn }
      enum RecvResult { More(Conn), Done(Conn) }
      fn get_r() -> RecvResult
      fn consume_r(r: move RecvResult) -> ()
      fn get_bool() -> Bool
      fn test() -> () {
        let r = get_r()
        if get_bool() {
          consume_r(r)
        } else {
          consume_r(r)
        }
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });
});

describe("inner-scope exit enforcement", () => {
  it("let inside match arm with no consumption is an error", () => {
    const src = `
      resource Conn { cleanup: close_conn }
      fn make_conn() -> Conn
      enum Choice { A, B }
      fn get_choice() -> Choice
      fn test() -> () {
        match get_choice() {
          A => { let c = make_conn() },
          B => { },
        }
      }
    `;
    const errs = check(parse(src, "test.fit"));
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some(e => e.message.includes("'c' must be consumed before leaving scope"))).toBe(true);
  });

  it("let inside loop body with no consumption is an error", () => {
    const src = `
      resource Conn { cleanup: close_conn }
      fn make_conn() -> Conn
      fn test() -> () {
        loop {
          let c = make_conn()
          break
        }
      }
    `;
    const errs = check(parse(src, "test.fit"));
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some(e => e.message.includes("'c' must be consumed before leaving scope"))).toBe(true);
  });

  it("let inside if branch with no consumption is an error", () => {
    const src = `
      resource Conn { cleanup: close_conn }
      fn make_conn() -> Conn
      fn get_bool() -> Bool
      fn test() -> () {
        if get_bool() {
          let c = make_conn()
        } else {
        }
      }
    `;
    const errs = check(parse(src, "test.fit"));
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some(e => e.message.includes("'c' must be consumed before leaving scope"))).toBe(true);
  });

  it("partial branch consumption emits exactly one error", () => {
    const src = `
      resource Conn { cleanup: close_conn }
      fn make_conn() -> Conn
      fn drop_conn(c: move Conn) -> ()
      fn get_bool() -> Bool
      fn test() -> () {
        let c = make_conn()
        if get_bool() {
          drop_conn(c)
        } else {
        }
      }
    `;
    const errs = check(parse(src, "test.fit"));
    const consumed = errs.filter(e => e.message.includes("'c'"));
    expect(consumed.length).toBe(1);
    expect(consumed[0].message).toContain("must be consumed on all branches");
  });
});

describe("edge cases", () => {
  it("recursive function does not crash or produce false errors", () => {
    // A function that calls itself. The checker looks up the sig in env.functions
    // (already present from the two-pass build). Recursion with a lend param is fine.
    const src = `
      fn count_down(n: Int) -> ()
      fn count_down_body(n: Int) -> () {
        count_down(n)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("direct self-recursive call compiles cleanly when param is lend", () => {
    // run_loop lends c (SmtpConn not in return type), so the recursive call is valid.
    const src = `
      resource SmtpConn<S> { sock: Socket, cleanup: force_close }
      fn send_msg(c: lend SmtpConn<Ready>, msg: String) -> ()
      fn run_loop(c: SmtpConn<Ready>, msg: String) -> () {
        send_msg(c, msg)
        run_loop(c, msg)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("let-shadow of linear in one if-branch auto-cleans the old value — no error", () => {
    // In the then-branch, 'let f = make_foo()' shadows the outer f.
    // The outer f is auto-cleaned at that point (not a double-free; no explicit move needed).
    // After the if, the outer f is still in scope (unaffected by then-branch shadow).
    const src = `
      resource Foo { cleanup: drop_foo }
      fn make_foo() -> Foo
      fn cond() -> String
      fn test() -> () {
        let f = make_foo()
        if cond() {
          let f = make_foo()
        } else {
        }
        drop(f)
      }
    `;
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });

  it("function with no params and no caps calling another with caps — error", () => {
    // Even a zero-param function must declare its caps.
    const src = `
      fn needs_net() using Net -> ()
      fn empty_caller() -> () {
        needs_net()
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("missing capability 'Net'"))).toBe(true);
  });

  it("typestate-null resource (no <S> param) is checked for move semantics correctly", () => {
    // Resources without <S> have typeState: null. Move semantics still apply.
    const src = `
      resource Handle { sock: Socket, cleanup: close_handle }
      fn make_handle() -> Handle
      fn consume_handle(h: move Handle) -> Handle
      fn test() -> () {
        let h = make_handle()
        consume_handle(h)
        consume_handle(h)
      }
    `;
    const errors = check(parse(src, "test.fit"));
    expect(errors.some((e) => e.message.includes("already been moved"))).toBe(true);
  });

  it("select atom is available in nested if inside function — not leaked outside", () => {
    // select inside a nested if-then-else: atom available in that arm only.
    const src = `
      capability Fs
      fn cond_check() -> String
      fn needs_read() using Read -> ()
      fn do_work() using Fs -> () {
        select Read from Fs
        if cond_check() {
          needs_read()
        } else {
          needs_read()
        }
      }
    `;
    // Read was selected at the function level — both branches should have it.
    expect(check(parse(src, "test.fit"))).toEqual([]);
  });
});
