import * as fs from "fs";
import * as path from "path";
import { Program, Stmt } from "../src/ast";
import { parse } from "../src/parser";

test("ast types import", () => {
  const _: Program = { decls: [] };
  expect(_.decls).toHaveLength(0);
});

test("parse empty program", () => {
  const prog = parse("", "empty.fit");
  expect(prog.decls).toHaveLength(0);
});

test("parse skips line comments", () => {
  const prog = parse("// this is a comment\n", "comment.fit");
  expect(prog.decls).toHaveLength(0);
});

test("parse skips block comments", () => {
  const prog = parse("/* block\n   comment */", "block.fit");
  expect(prog.decls).toHaveLength(0);
});

test("parse capability decl", () => {
  const prog = parse("capability ChargeCard", "t.fit");
  expect(prog.decls).toHaveLength(1);
  const d = prog.decls[0];
  expect(d.kind).toBe("capability");
  if (d.kind === "capability") expect(d.name).toBe("ChargeCard");
});

test("parse record decl", () => {
  const prog = parse(`record Point {\n    x: Int,\n    y: Int,\n}`, "t.fit");
  expect(prog.decls).toHaveLength(1);
  const d = prog.decls[0];
  expect(d.kind).toBe("record");
  if (d.kind === "record") {
    expect(d.name).toBe("Point");
    expect(d.fields).toHaveLength(2);
    expect(d.fields[0].name).toBe("x");
    expect(d.fields[0].type_).toEqual({ kind: "named", name: "Int", typeArg: null });
  }
});

test("parse enum unit variants", () => {
  const prog = parse("enum Direction { North, East, South, West }", "t.fit");
  const d = prog.decls[0];
  expect(d.kind).toBe("enum");
  if (d.kind === "enum") {
    expect(d.variants).toHaveLength(4);
    expect(d.variants[0]).toEqual({ name: "North", payload: null });
    expect(d.variants[3]).toEqual({ name: "West", payload: null });
  }
});

test("parse enum variants with payload", () => {
  const prog = parse(
    `enum ConnEvent {\n    Data(Bytes),\n    Error(String),\n    Closed,\n}`,
    "t.fit"
  );
  const d = prog.decls[0];
  expect(d.kind).toBe("enum");
  if (d.kind === "enum") {
    expect(d.variants[0]).toEqual({
      name: "Data",
      payload: { kind: "named", name: "Bytes", typeArg: null },
    });
    expect(d.variants[1]).toEqual({
      name: "Error",
      payload: { kind: "named", name: "String", typeArg: null },
    });
    expect(d.variants[2]).toEqual({ name: "Closed", payload: null });
  }
});

test("parse type alias", () => {
  const prog = parse("type SessionError = SmtpError | IoError", "t.fit");
  const d = prog.decls[0];
  expect(d.kind).toBe("type_alias");
  if (d.kind === "type_alias") {
    expect(d.name).toBe("SessionError");
    expect(d.members).toEqual(["SmtpError", "IoError"]);
  }
});

test("parse resource without typestate", () => {
  const prog = parse(
    `resource File {\n    handle: FileHandle,\n    cleanup: force_close,\n}`,
    "t.fit"
  );
  const d = prog.decls[0];
  expect(d.kind).toBe("resource");
  if (d.kind === "resource") {
    expect(d.name).toBe("File");
    expect(d.typeParam).toBeNull();
    expect(d.cleanup).toEqual({ fallback: false, fn: "force_close" });
  }
});

test("parse resource with typestate param", () => {
  const prog = parse(
    `resource Conn<S> {\n    sock: TcpSocket,\n    cleanup: tcp_force_close,\n}`,
    "t.fit"
  );
  const d = prog.decls[0];
  expect(d.kind).toBe("resource");
  if (d.kind === "resource") {
    expect(d.name).toBe("Conn");
    expect(d.typeParam).toBe("S");
  }
});

test("parse resource with fallback cleanup", () => {
  const prog = parse(
    `resource TxConn<S> {\n    sock: TcpSocket,\n    cleanup: fallback tcp_force_close,\n}`,
    "t.fit"
  );
  const d = prog.decls[0];
  if (d.kind === "resource") {
    expect(d.cleanup).toEqual({ fallback: true, fn: "tcp_force_close" });
  }
});

test("parse fn signature only — no using", () => {
  const prog = parse("fn greet(name: String) -> ()", "t.fit");
  const d = prog.decls[0];
  expect(d.kind).toBe("fn");
  if (d.kind === "fn") {
    expect(d.name).toBe("greet");
    expect(d.params).toEqual([
      { name: "name", type_: { kind: "named", name: "String", typeArg: null } },
    ]);
    expect(d.caps).toEqual([]);
    expect(d.returnType).toEqual({ kind: "unit" });
    expect(d.body).toBeNull();
  }
});

test("parse fn signature with using", () => {
  const prog = parse("fn serve(req: Request) using Net -> Result<Response, IoError>", "t.fit");
  const d = prog.decls[0];
  if (d.kind === "fn") {
    expect(d.caps).toEqual(["Net"]);
    expect(d.returnType).toEqual({
      kind: "result",
      ok: { kind: "named", name: "Response", typeArg: null },
      err: { kind: "named", name: "IoError", typeArg: null },
    });
    expect(d.body).toBeNull();
  }
});

test("parse fn signature with multiple caps", () => {
  const prog = parse(
    "fn charge(token: AuthToken, amount: Cents) using Net, ChargeCard -> Result<Receipt, PaymentError>",
    "t.fit"
  );
  const d = prog.decls[0];
  if (d.kind === "fn") {
    expect(d.caps).toEqual(["Net", "ChargeCard"]);
  }
});

test("parse fn signature with typestate param type", () => {
  const prog = parse(
    "fn connect(host: String) using Net -> Result<SmtpConn<Fresh>, SessionError>",
    "t.fit"
  );
  const d = prog.decls[0];
  if (d.kind === "fn") {
    expect(d.returnType).toEqual({
      kind: "result",
      ok: {
        kind: "named",
        name: "SmtpConn",
        typeArg: { kind: "named", name: "Fresh", typeArg: null },
      },
      err: { kind: "named", name: "SessionError", typeArg: null },
    });
  }
});

test("parse fn with empty body", () => {
  const prog = parse("fn noop() -> () {\n}", "t.fit");
  const d = prog.decls[0];
  if (d.kind === "fn") {
    expect(d.body).toEqual([]);
  }
});

// Helper for statement-level tests
function parseFnBody(src: string): Stmt[] {
  const prog = parse(`fn f() -> () {\n${src}\n}`, "t.fit");
  const d = prog.decls[0];
  if (d.kind !== "fn" || d.body === null) throw new Error("not a fn with body");
  return d.body;
}

test("parse let binding", () => {
  const stmts = parseFnBody("let x = foo");
  expect(stmts).toHaveLength(1);
  const s = stmts[0];
  expect(s.kind).toBe("let");
  if (s.kind === "let") {
    expect(s.name).toBe("x");
    expect(s.mut).toBe(false);
    expect(s.init).toEqual({ kind: "var", name: "foo", pos: expect.any(Object) });
  }
});

test("parse let mut binding", () => {
  const stmts = parseFnBody("let mut remaining = msgs");
  const s = stmts[0];
  expect(s.kind).toBe("let");
  if (s.kind === "let") {
    expect(s.mut).toBe(true);
    expect(s.name).toBe("remaining");
  }
});

test("parse rebind", () => {
  const stmts = parseFnBody("remaining = rest");
  const s = stmts[0];
  expect(s.kind).toBe("rebind");
  if (s.kind === "rebind") {
    expect(s.name).toBe("remaining");
    expect(s.expr).toEqual({ kind: "var", name: "rest", pos: expect.any(Object) });
  }
});

test("parse call expression statement", () => {
  const stmts = parseFnBody("audit_log(receipt)");
  const s = stmts[0];
  expect(s.kind).toBe("expr");
  if (s.kind === "expr") {
    const e = s.expr;
    expect(e.kind).toBe("call");
    if (e.kind === "call") {
      expect(e.fn).toBe("audit_log");
      expect(e.args).toHaveLength(1);
      expect(e.args[0]).toEqual({ kind: "var", name: "receipt", pos: expect.any(Object) });
    }
  }
});

test("parse try expression", () => {
  const stmts = parseFnBody("let token = validate_card(card)?");
  const s = stmts[0];
  if (s.kind === "let") {
    expect(s.init).toEqual({
      kind: "try",
      expr: {
        kind: "call",
        fn: "validate_card",
        args: [{ kind: "var", name: "card", pos: expect.any(Object) }],
        pos: expect.any(Object),
      },
      pos: expect.any(Object),
    });
  }
});

test("parse break statement", () => {
  const stmts = parseFnBody("break");
  expect(stmts[0].kind).toBe("break");
});

test("parse drop call", () => {
  const stmts = parseFnBody("drop(conn)");
  const s = stmts[0];
  if (s.kind === "expr") {
    expect(s.expr.kind).toBe("call");
    if (s.expr.kind === "call") expect(s.expr.fn).toBe("drop");
  }
});

test("parse if/else", () => {
  const stmts = parseFnBody(`if cond {\n    a()\n} else {\n    b()\n}`);
  expect(stmts).toHaveLength(1);
  const s = stmts[0];
  expect(s.kind).toBe("if");
  if (s.kind === "if") {
    expect(s.cond).toEqual({ kind: "var", name: "cond", pos: expect.any(Object) });
    expect(s.then).toHaveLength(1);
    expect(s.else_).toHaveLength(1);
  }
});

test("parse loop with break", () => {
  const stmts = parseFnBody(`loop {\n    break\n}`);
  expect(stmts).toHaveLength(1);
  const s = stmts[0];
  expect(s.kind).toBe("loop");
  if (s.kind === "loop") {
    expect(s.body).toHaveLength(1);
    expect(s.body[0].kind).toBe("break");
  }
});

test("parse match — unit variant arm + block arm", () => {
  const stmts = parseFnBody(
    `match next(remaining) {\n    None => break,\n    Some(msg, rest) => {\n        send_message(c, msg)?\n        remaining = rest\n    },\n}`
  );
  expect(stmts).toHaveLength(1);
  const s = stmts[0];
  expect(s.kind).toBe("match");
  if (s.kind === "match") {
    expect(s.arms).toHaveLength(2);
    const arm0 = s.arms[0];
    expect(arm0.pattern).toEqual({ kind: "variant", name: "None", binds: [] });
    expect(arm0.body).toHaveLength(1);
    expect(arm0.body[0].kind).toBe("break");
    const arm1 = s.arms[1];
    expect(arm1.pattern).toEqual({ kind: "variant", name: "Some", binds: ["msg", "rest"] });
    expect(arm1.body).toHaveLength(2);
  }
});

test("parse match — wildcard arm", () => {
  const stmts = parseFnBody(`match x {\n    _ => break,\n}`);
  const s = stmts[0];
  if (s.kind === "match") {
    expect(s.arms[0].pattern).toEqual({ kind: "wildcard" });
  }
});

test("parse select statement", () => {
  const stmts = parseFnBody("select Read, Write from Fs");
  expect(stmts).toHaveLength(1);
  const s = stmts[0];
  expect(s.kind).toBe("select");
  if (s.kind === "select") {
    expect(s.atoms).toEqual(["Read", "Write"]);
    expect(s.from).toBe("Fs");
  }
});

test("parse Ok(value)", () => {
  const stmts = parseFnBody("Ok(receipt)");
  const s = stmts[0];
  if (s.kind === "expr") {
    expect(s.expr.kind).toBe("ok");
    if (s.expr.kind === "ok") {
      expect(s.expr.expr).toEqual({ kind: "var", name: "receipt", pos: expect.any(Object) });
    }
  }
});

test("parse Ok(())", () => {
  const stmts = parseFnBody("Ok(())");
  const s = stmts[0];
  if (s.kind === "expr") {
    expect(s.expr.kind).toBe("ok");
    if (s.expr.kind === "ok") {
      expect(s.expr.expr.kind).toBe("unit_val");
    }
  }
});

test("parse Err(e)", () => {
  const stmts = parseFnBody("Err(e)");
  const s = stmts[0];
  if (s.kind === "expr") {
    expect(s.expr.kind).toBe("err");
  }
});

test("parse try on Ok expr", () => {
  const stmts = parseFnBody("let x = Ok(v)?");
  const s = stmts[0];
  if (s.kind === "let") {
    expect(s.init.kind).toBe("try");
    if (s.init.kind === "try") {
      expect(s.init.expr.kind).toBe("ok");
    }
  }
});

test("parse payment.fit — no errors", () => {
  const src = fs.readFileSync(path.join(__dirname, "payment.fit"), "utf8");
  const prog = parse(src, "payment.fit");
  // capability, resource, enum, validate_card, execute_charge, audit_log, process_payment = 7
  expect(prog.decls).toHaveLength(7);
});

test("parse payment.fit — process_payment body", () => {
  const src = fs.readFileSync(path.join(__dirname, "payment.fit"), "utf8");
  const prog = parse(src, "payment.fit");
  const fn_ = prog.decls.find((d) => d.kind === "fn" && d.name === "process_payment");
  expect(fn_).toBeDefined();
  if (fn_?.kind === "fn") {
    expect(fn_.body).not.toBeNull();
    expect(fn_.body).toHaveLength(4); // let token, let receipt, audit_log?, Ok(receipt)
    expect(fn_.caps).toEqual(["Net", "ChargeCard"]);
  }
});

test("parse smtp.fit — no errors", () => {
  const src = fs.readFileSync(path.join(__dirname, "smtp.fit"), "utf8");
  const prog = parse(src, "smtp.fit");
  // enum SmtpState, resource SmtpConn, enum SmtpError, type SessionError,
  // connect, greet, auth, ready, quit, close, send_message, deliver_batch, run_session = 13
  expect(prog.decls).toHaveLength(13);
});

test("parse smtp.fit — deliver_batch body", () => {
  const src = fs.readFileSync(path.join(__dirname, "smtp.fit"), "utf8");
  const prog = parse(src, "smtp.fit");
  const fn_ = prog.decls.find((d) => d.kind === "fn" && d.name === "deliver_batch");
  if (fn_?.kind !== "fn" || fn_.body === null) throw new Error("missing deliver_batch");
  // let mut remaining, loop, Ok(())
  expect(fn_.body).toHaveLength(3);
  expect(fn_.body[1].kind).toBe("loop");
  if (fn_.body[1].kind === "loop") {
    const loopBody = fn_.body[1].body;
    expect(loopBody).toHaveLength(1);
    expect(loopBody[0].kind).toBe("match");
  }
});

test("parse smtp.fit — run_session body", () => {
  const src = fs.readFileSync(path.join(__dirname, "smtp.fit"), "utf8");
  const prog = parse(src, "smtp.fit");
  const fn_ = prog.decls.find((d) => d.kind === "fn" && d.name === "run_session");
  if (fn_?.kind !== "fn" || fn_.body === null) throw new Error("missing run_session");
  // let c x4, deliver_batch?, let c = quit?, close(c) = 7 stmts
  expect(fn_.body).toHaveLength(7);
});
