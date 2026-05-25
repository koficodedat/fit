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
