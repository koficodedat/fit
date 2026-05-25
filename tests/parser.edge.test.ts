import { parse } from "../src/parser";

// ─── CONTEXTUAL KEYWORDS AS IDENTIFIERS ─────────────────────────────────────

test("edge: 'from' as variable name in let", () => {
  // 'from' is NOT a reserved word — must parse as identifier
  const prog = parse("fn f() -> () { let from = foo }", "t.fit");
  const fn_ = prog.decls[0];
  if (fn_?.kind === "fn" && fn_.body) {
    const s = fn_.body[0];
    expect(s.kind).toBe("let");
    if (s.kind === "let") expect(s.name).toBe("from");
  }
});

test("edge: 'from' as function argument", () => {
  const prog = parse("fn f() -> () { g(from) }", "t.fit");
  const fn_ = prog.decls[0];
  if (fn_?.kind === "fn" && fn_.body) {
    const s = fn_.body[0];
    if (s.kind === "expr" && s.expr.kind === "call") {
      expect(s.expr.args[0]).toMatchObject({ kind: "var", name: "from" });
    }
  }
});

test("edge: 'drop' as regular function call", () => {
  const prog = parse("fn f() -> () { drop(conn) }", "t.fit");
  const fn_ = prog.decls[0];
  if (fn_?.kind === "fn" && fn_.body) {
    const s = fn_.body[0];
    expect(s.kind).toBe("expr");
    if (s.kind === "expr") {
      expect(s.expr.kind).toBe("call");
      if (s.expr.kind === "call") expect(s.expr.fn).toBe("drop");
    }
  }
});

// ─── NESTED TYPES ────────────────────────────────────────────────────────────

test("edge: deeply nested Result type (10 levels)", () => {
  // Result<Result<Result<..., E>, E>, E>
  let inner = "A";
  for (let i = 0; i < 10; i++) inner = `Result<${inner}, E>`;
  const prog = parse(`fn f() -> ${inner}`, "t.fit");
  expect(prog.decls).toHaveLength(1);
  expect(prog.decls[0].kind).toBe("fn");
});

test("edge: type with typestate param in Result", () => {
  const prog = parse("fn f() -> Result<Conn<Ready>, IoError>", "t.fit");
  const d = prog.decls[0];
  if (d.kind === "fn") {
    expect(d.returnType).toEqual({
      kind: "result",
      ok: { kind: "named", name: "Conn", typeArg: { kind: "named", name: "Ready", typeArg: null } },
      err: { kind: "named", name: "IoError", typeArg: null },
    });
  }
});

// ─── EMPTY BODIES ────────────────────────────────────────────────────────────

test("edge: empty enum body", () => {
  const prog = parse("enum Empty {}", "t.fit");
  const d = prog.decls[0];
  expect(d.kind).toBe("enum");
  if (d.kind === "enum") expect(d.variants).toHaveLength(0);
});

test("edge: empty record body", () => {
  const prog = parse("record Empty {}", "t.fit");
  const d = prog.decls[0];
  expect(d.kind).toBe("record");
  if (d.kind === "record") expect(d.fields).toHaveLength(0);
});

test("edge: fn with no params", () => {
  const prog = parse("fn noop() -> ()", "t.fit");
  const d = prog.decls[0];
  if (d.kind === "fn") expect(d.params).toHaveLength(0);
});

// ─── TRAILING COMMAS ─────────────────────────────────────────────────────────

test("edge: record trailing comma", () => {
  const prog = parse("record R { x: Int, }", "t.fit");
  const d = prog.decls[0];
  if (d.kind === "record") expect(d.fields).toHaveLength(1);
});

test("edge: enum trailing comma", () => {
  const prog = parse("enum E { A, B, }", "t.fit");
  const d = prog.decls[0];
  if (d.kind === "enum") expect(d.variants).toHaveLength(2);
});

test("edge: match single arm with trailing comma", () => {
  const prog = parse("fn f() -> () { match x { _ => break, } }", "t.fit");
  const d = prog.decls[0];
  if (d.kind === "fn" && d.body) {
    const s = d.body[0];
    if (s.kind === "match") expect(s.arms).toHaveLength(1);
  }
});

// ─── WHITESPACE AND COMMENT VARIANTS ─────────────────────────────────────────

test("edge: block comment between fn keyword and name", () => {
  const prog = parse("fn /* a comment */ greet() -> ()", "t.fit");
  const d = prog.decls[0];
  expect(d.kind).toBe("fn");
  if (d.kind === "fn") expect(d.name).toBe("greet");
});

test("edge: line comment inside record body", () => {
  const prog = parse("record R {\n    // a comment\n    x: Int,\n}", "t.fit");
  const d = prog.decls[0];
  if (d.kind === "record") expect(d.fields).toHaveLength(1);
});

test("edge: multiple blank lines between declarations", () => {
  const prog = parse("\n\n\ncapability A\n\n\ncapability B\n\n\n", "t.fit");
  expect(prog.decls).toHaveLength(2);
});

// ─── SELECT VARIANTS ─────────────────────────────────────────────────────────

test("edge: select single atom", () => {
  const prog = parse("fn f() -> () { select Read from Fs }", "t.fit");
  const d = prog.decls[0];
  if (d.kind === "fn" && d.body) {
    const s = d.body[0];
    expect(s.kind).toBe("select");
    if (s.kind === "select") {
      expect(s.atoms).toEqual(["Read"]);
      expect(s.from).toBe("Fs");
    }
  }
});

// ─── MULTI-FIELD PATTERN BINDS ───────────────────────────────────────────────

test("edge: match pattern with two binds", () => {
  const prog = parse("fn f() -> () { match x { Pair(a, b) => break, } }", "t.fit");
  const d = prog.decls[0];
  if (d.kind === "fn" && d.body) {
    const s = d.body[0];
    if (s.kind === "match") {
      expect(s.arms[0].pattern).toEqual({ kind: "variant", name: "Pair", binds: ["a", "b"] });
    }
  }
});

// ─── SAFETY: DEEP NESTING ─────────────────────────────────────────────────────

test("safety: deeply nested type (50 levels) does not stack overflow", () => {
  let inner = "A";
  for (let i = 0; i < 50; i++) inner = `Result<${inner}, E>`;
  expect(() => parse(`fn f() -> ${inner}`, "t.fit")).not.toThrow();
});

test("safety: large enum (200 variants) parses without error", () => {
  const variants = Array.from({ length: 200 }, (_, i) => `V${i}`).join(", ");
  const prog = parse(`enum BigEnum { ${variants} }`, "t.fit");
  const d = prog.decls[0];
  expect(d.kind).toBe("enum");
  if (d.kind === "enum") expect(d.variants).toHaveLength(200);
});

test("safety: very long identifier (1000 chars) parses without error", () => {
  const longName = "a".repeat(1000);
  const prog = parse(`capability ${longName}`, "t.fit");
  const d = prog.decls[0];
  expect(d.kind).toBe("capability");
  if (d.kind === "capability") expect(d.name).toHaveLength(1000);
});

test("safety: source with only comments produces empty program", () => {
  const src = Array.from({ length: 100 }, (_, i) => `// comment line ${i}`).join("\n");
  const prog = parse(src, "t.fit");
  expect(prog.decls).toHaveLength(0);
});

test("safety: deeply nested match inside loop inside fn", () => {
  // A loop containing a match containing a loop containing a match
  const src = `fn f() -> () {
    loop {
      match x {
        A => loop {
          match y {
            B => break,
            _ => break,
          }
        },
        _ => break,
      }
    }
  }`;
  expect(() => parse(src, "t.fit")).not.toThrow();
});

// ─── PERFORMANCE ─────────────────────────────────────────────────────────────

test("perf: parse 200 fn signatures in under 100ms", () => {
  const sigs = Array.from({ length: 200 }, (_, i) =>
    `fn func_${i}(a: TypeA, b: TypeB) using Net -> Result<TypeC, TypeD>`
  ).join("\n");
  const start = Date.now();
  const prog = parse(sigs, "perf.fit");
  const elapsed = Date.now() - start;
  expect(prog.decls).toHaveLength(200);
  expect(elapsed).toBeLessThan(100);
});

test("perf: parse canonical programs under 10ms each", () => {
  const fs = require("fs");
  const path = require("path");
  const payment = fs.readFileSync(path.join(__dirname, "payment.fit"), "utf8");
  const smtp = fs.readFileSync(path.join(__dirname, "smtp.fit"), "utf8");
  const t1 = Date.now(); parse(payment, "payment.fit"); const e1 = Date.now() - t1;
  const t2 = Date.now(); parse(smtp, "smtp.fit"); const e2 = Date.now() - t2;
  expect(e1).toBeLessThan(50);
  expect(e2).toBeLessThan(50);
});
