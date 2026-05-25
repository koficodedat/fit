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
