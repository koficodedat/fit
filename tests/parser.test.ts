import { Program, Decl, Stmt, Expr, Type, Pattern } from "../src/ast";
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
    expect(d.variants[0]).toEqual({ name: "Data",  payload: { kind: "named", name: "Bytes",  typeArg: null } });
    expect(d.variants[1]).toEqual({ name: "Error", payload: { kind: "named", name: "String", typeArg: null } });
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
    expect(d.params).toEqual([{ name: "name", type_: { kind: "named", name: "String", typeArg: null } }]);
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
      ok:  { kind: "named", name: "Response", typeArg: null },
      err: { kind: "named", name: "IoError",  typeArg: null },
    });
    expect(d.body).toBeNull();
  }
});

test("parse fn signature with multiple caps", () => {
  const prog = parse("fn charge(token: AuthToken, amount: Cents) using Net, ChargeCard -> Result<Receipt, PaymentError>", "t.fit");
  const d = prog.decls[0];
  if (d.kind === "fn") {
    expect(d.caps).toEqual(["Net", "ChargeCard"]);
  }
});

test("parse fn signature with typestate param type", () => {
  const prog = parse("fn connect(host: String) using Net -> Result<SmtpConn<Fresh>, SessionError>", "t.fit");
  const d = prog.decls[0];
  if (d.kind === "fn") {
    expect(d.returnType).toEqual({
      kind: "result",
      ok: { kind: "named", name: "SmtpConn", typeArg: { kind: "named", name: "Fresh", typeArg: null } },
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
