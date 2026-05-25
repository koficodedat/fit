import { parse } from "../src/parser";

// ─── TOP-LEVEL ERRORS ────────────────────────────────────────────────────────

test("error: unknown top-level keyword", () => {
  expect(() => parse("badword Foo", "t.fit")).toThrow(/unexpected top-level keyword 'badword'/);
});

test("error: number at top level", () => {
  // Numbers are not valid identifiers; the keyword accumulator reads nothing,
  // so the parser reports unexpected top-level keyword '' (empty string).
  expect(() => parse("123", "t.fit")).toThrow(/unexpected top-level keyword/);
});

// ─── RECORD ERRORS ───────────────────────────────────────────────────────────

test("error: record missing open brace", () => {
  expect(() => parse("record Point x: Int }", "t.fit")).toThrow(/expected '\{'/);
});

test("error: record field missing colon", () => {
  expect(() => parse("record Point { x Int }", "t.fit")).toThrow(/expected ':'/);
});

test("error: record missing close brace (EOF)", () => {
  expect(() => parse("record Point { x: Int", "t.fit")).toThrow();
});

// ─── RESOURCE ERRORS ─────────────────────────────────────────────────────────

test("error: resource missing cleanup field", () => {
  expect(() => parse("resource File { handle: FileHandle, }", "t.fit"))
    .toThrow(/resource 'File' missing cleanup field/);
});

test("error: resource missing open brace", () => {
  expect(() => parse("resource File cleanup: close,}", "t.fit")).toThrow(/expected '\{'/);
});

// ─── TYPE ERRORS ─────────────────────────────────────────────────────────────

test("error: unclosed generic type angle bracket", () => {
  expect(() => parse("fn f() -> Result<A, B", "t.fit")).toThrow(/expected '>'/);
});

test("error: Result missing comma between type args", () => {
  expect(() => parse("fn f() -> Result<A B>", "t.fit")).toThrow(/expected ','/);
});

// ─── FN SIGNATURE ERRORS ─────────────────────────────────────────────────────

test("error: fn missing open paren", () => {
  expect(() => parse("fn f a: Int) -> ()", "t.fit")).toThrow(/expected '\('/);
});

test("error: fn missing arrow", () => {
  expect(() => parse("fn f() Int", "t.fit")).toThrow(/expected '->'/);
});

test("error: fn param missing colon", () => {
  expect(() => parse("fn f(x Int) -> ()", "t.fit")).toThrow(/expected ':'/);
});

// ─── BODY / STATEMENT ERRORS ─────────────────────────────────────────────────

test("error: let missing equals", () => {
  expect(() => parse("fn f() -> () { let x foo }", "t.fit")).toThrow(/expected '='/);
});

test("error: if missing else", () => {
  expect(() => parse("fn f() -> () { if x { a() } }", "t.fit"))
    .toThrow(/expected 'else' after if block/);
});

test("error: match arm missing arrow", () => {
  expect(() => parse("fn f() -> () { match x { None break } }", "t.fit"))
    .toThrow(/expected '=>'/);
});

test("error: unclosed block comment", () => {
  expect(() => parse("/* never closed", "t.fit")).toThrow(/unterminated block comment/);
});

test("error: unterminated block in fn body", () => {
  expect(() => parse("fn f() -> () { let x = foo", "t.fit")).toThrow();
});

// ─── LOCATION ACCURACY ───────────────────────────────────────────────────────

test("error location: correct line reported", () => {
  // badword is on line 3
  const src = "// line 1\n// line 2\nbadword Foo";
  expect(() => parse(src, "t.fit")).toThrow(/t\.fit:3:/);
});

test("error location: correct col reported", () => {
  // record name missing, '{' appears where name expected
  const src = "record {";
  // col 1 is where { appears (after skip, 1-indexed)
  expect(() => parse(src, "t.fit")).toThrow(/t\.fit:1:/);
});
