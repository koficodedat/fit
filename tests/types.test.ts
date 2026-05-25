// tests/types.test.ts
import {
  FitType, ResolveEnv, TypeEnv,
  resolveType, inferParamMode, buildTypeEnv,
} from "../src/types";
import { Type } from "../src/ast";
import * as fs from "fs";
import * as path from "path";
import { parse } from "../src/parser";

describe("types module data structures", () => {
  it("can construct a FitType.plain value", () => {
    const t: FitType = { kind: "plain", mode: "unrestricted", name: "String" };
    expect(t.kind).toBe("plain");
  });

  it("can construct a FitType.resource value", () => {
    const t: FitType = {
      kind: "resource", mode: "linear",
      name: "AuthToken", typeState: null, cleanup: "void_token", fallback: false,
    };
    expect(t.kind).toBe("resource");
  });

  it("can construct a FitType.result value", () => {
    const ok: FitType  = { kind: "plain",  mode: "unrestricted", name: "Receipt" };
    const err: FitType = { kind: "plain",  mode: "unrestricted", name: "PaymentError" };
    const t: FitType   = { kind: "result", mode: "unrestricted", ok, err };
    expect(t.kind).toBe("result");
  });

  it("can construct a FitType.unit value", () => {
    const t: FitType = { kind: "unit", mode: "unrestricted" };
    expect(t.kind).toBe("unit");
  });

  it("can construct a FitType.alias value", () => {
    const t: FitType = { kind: "alias", mode: "unrestricted", name: "SessionError", members: ["SmtpError", "IoError"] };
    expect(t.kind).toBe("alias");
  });

  it("can construct a TypeEnv", () => {
    const env: TypeEnv = { resources: new Map(), aliases: new Map(), functions: new Map() };
    expect(env.resources.size).toBe(0);
  });

  it("can construct a ResolveEnv without the functions map", () => {
    const env: ResolveEnv = { resources: new Map(), aliases: new Map() };
    expect(env.resources.size).toBe(0);
  });

  it("exports resolveType as a function", () => {
    expect(typeof resolveType).toBe("function");
  });

  it("exports inferParamMode as a function", () => {
    expect(typeof inferParamMode).toBe("function");
  });

  it("exports buildTypeEnv as a function", () => {
    expect(typeof buildTypeEnv).toBe("function");
  });

  it("TypeEnv is structurally assignable to ResolveEnv (Pick subset relationship)", () => {
    const full: TypeEnv    = { resources: new Map(), aliases: new Map(), functions: new Map() };
    const narrow: ResolveEnv = full;
    expect(narrow.resources.size).toBe(0);
  });
});

describe("resolveType", () => {
  const testEnv: ResolveEnv = {
    resources: new Map([
      ["AuthToken", { name: "AuthToken", typeParam: null, cleanup: "void_token",      fallback: false }],
      ["SmtpConn",  { name: "SmtpConn",  typeParam: "S",  cleanup: "tcp_force_close", fallback: false }],
    ]),
    aliases: new Map([
      ["SessionError", ["SmtpError", "IoError"]],
    ]),
  };

  it("resolves unit type", () => {
    expect(resolveType({ kind: "unit" }, testEnv)).toEqual({ kind: "unit", mode: "unrestricted" });
  });

  it("resolves undeclared named type as plain unrestricted", () => {
    expect(resolveType({ kind: "named", name: "String", typeArg: null }, testEnv))
      .toEqual({ kind: "plain", mode: "unrestricted", name: "String" });
  });

  it("resolves declared resource without typestate", () => {
    expect(resolveType({ kind: "named", name: "AuthToken", typeArg: null }, testEnv))
      .toEqual({ kind: "resource", mode: "linear", name: "AuthToken", typeState: null, cleanup: "void_token", fallback: false });
  });

  it("resolves resource with typestate argument", () => {
    const ast: Type = { kind: "named", name: "SmtpConn", typeArg: { kind: "named", name: "Ready", typeArg: null } };
    expect(resolveType(ast, testEnv))
      .toEqual({ kind: "resource", mode: "linear", name: "SmtpConn", typeState: "Ready", cleanup: "tcp_force_close", fallback: false });
  });

  it("resolves alias type", () => {
    expect(resolveType({ kind: "named", name: "SessionError", typeArg: null }, testEnv))
      .toEqual({ kind: "alias", mode: "unrestricted", name: "SessionError", members: ["SmtpError", "IoError"] });
  });

  it("resolves Result<AuthToken, PaymentError> — ok is resource, err is plain", () => {
    const ast: Type = {
      kind: "result",
      ok:  { kind: "named", name: "AuthToken",    typeArg: null },
      err: { kind: "named", name: "PaymentError", typeArg: null },
    };
    expect(resolveType(ast, testEnv)).toEqual({
      kind: "result",
      mode: "unrestricted",
      ok:  { kind: "resource", mode: "linear",      name: "AuthToken", typeState: null, cleanup: "void_token", fallback: false },
      err: { kind: "plain",    mode: "unrestricted", name: "PaymentError" },
    });
  });

  it("resolves Result<(), SessionError> — ok is unit, err is alias", () => {
    const ast: Type = {
      kind: "result",
      ok:  { kind: "unit" },
      err: { kind: "named", name: "SessionError", typeArg: null },
    };
    expect(resolveType(ast, testEnv)).toEqual({
      kind: "result",
      mode: "unrestricted",
      ok:  { kind: "unit",  mode: "unrestricted" },
      err: { kind: "alias", mode: "unrestricted", name: "SessionError", members: ["SmtpError", "IoError"] },
    });
  });

  it("resolves Result<(), SmtpConn<Closing>> — err branch is a resource", () => {
    const ast: Type = {
      kind: "result",
      ok:  { kind: "unit" },
      err: { kind: "named", name: "SmtpConn", typeArg: { kind: "named", name: "Closing", typeArg: null } },
    };
    expect(resolveType(ast, testEnv)).toEqual({
      kind: "result",
      mode: "unrestricted",
      ok:  { kind: "unit",     mode: "unrestricted" },
      err: { kind: "resource", mode: "linear", name: "SmtpConn", typeState: "Closing", cleanup: "tcp_force_close", fallback: false },
    });
  });

  it("resolves resource with non-named typeArg — typeState is null (parser invariant violation fallback)", () => {
    const ast: Type = { kind: "named", name: "SmtpConn", typeArg: { kind: "unit" } };
    expect(resolveType(ast, testEnv)).toEqual({
      kind: "resource", mode: "linear", name: "SmtpConn",
      typeState: null, cleanup: "tcp_force_close", fallback: false,
    });
  });
});

describe("inferParamMode", () => {
  it("move: param base type matches named return type directly", () => {
    const ret: Type = { kind: "named", name: "Conn", typeArg: { kind: "named", name: "Ready", typeArg: null } };
    expect(inferParamMode("Conn", ret)).toBe("move");
  });

  it("move: param base type found in Result ok branch", () => {
    const ret: Type = {
      kind: "result",
      ok:  { kind: "named", name: "SmtpConn", typeArg: { kind: "named", name: "Greeted", typeArg: null } },
      err: { kind: "named", name: "SessionError", typeArg: null },
    };
    expect(inferParamMode("SmtpConn", ret)).toBe("move");
  });

  it("move: param base type found in Result err branch only", () => {
    // e.g. fn try_op(c: Conn<Fresh>) -> Result<(), Conn<Fresh>> — err branch carries the resource back
    const ret: Type = {
      kind: "result",
      ok:  { kind: "unit" },
      err: { kind: "named", name: "SmtpConn", typeArg: { kind: "named", name: "Fresh", typeArg: null } },
    };
    expect(inferParamMode("SmtpConn", ret)).toBe("move");
  });

  it("move: param type found in typeArg of named return", () => {
    // e.g. fn wrap(c: SmtpConn<Ready>) -> Wrapper<SmtpConn>
    const ret: Type = { kind: "named", name: "Wrapper", typeArg: { kind: "named", name: "SmtpConn", typeArg: null } };
    expect(inferParamMode("SmtpConn", ret)).toBe("move");
  });

  it("lend: param base type not in return — send_message and close patterns", () => {
    // send_message(c: SmtpConn<Ready>, ...) -> Result<(), ...>: lend is CORRECT (caller keeps c)
    // close(c: SmtpConn<Closing>) -> Result<(), ...>: lend is WRONG (known gap — close consumes c,
    //   but SmtpConn is absent from the return type so the heuristic cannot detect it)
    const ret: Type = {
      kind: "result",
      ok:  { kind: "unit" },
      err: { kind: "named", name: "SessionError", typeArg: null },
    };
    expect(inferParamMode("SmtpConn", ret)).toBe("lend");
  });

  it("lend: different type in return — validate_card pattern", () => {
    // validate_card(card: CardDetails) -> Result<AuthToken, PaymentError>
    // CardDetails not in return → lend (correct: caller doesn't lose card details)
    const ret: Type = {
      kind: "result",
      ok:  { kind: "named", name: "AuthToken",    typeArg: null },
      err: { kind: "named", name: "PaymentError", typeArg: null },
    };
    expect(inferParamMode("CardDetails", ret)).toBe("lend");
  });

  it("lend: unit return always produces lend", () => {
    expect(inferParamMode("AuthToken", { kind: "unit" })).toBe("lend");
  });

  it("lend: empty base name never matches", () => {
    // Result-typed or unit-typed params produce baseName="" in buildTypeEnv; never move.
    const ret: Type = { kind: "named", name: "AuthToken", typeArg: null };
    expect(inferParamMode("", ret)).toBe("lend");
  });
});

describe("buildTypeEnv — payment.fit", () => {
  let env!: TypeEnv;
  beforeAll(() => {
    const src = fs.readFileSync(path.join(__dirname, "payment.fit"), "utf8");
    env = buildTypeEnv(parse(src, "payment.fit"));
  });

  it("registers AuthToken as a linear resource with cleanup void_token", () => {
    expect(env.resources.get("AuthToken")).toEqual({
      name: "AuthToken", typeParam: null, cleanup: "void_token", fallback: false,
    });
  });

  it("does not register capability ChargeCard as a resource", () => {
    expect(env.resources.has("ChargeCard")).toBe(false);
  });

  it("registers validate_card with cap [Net]", () => {
    const sig = env.functions.get("validate_card");
    expect(sig).toBeDefined();
    expect(sig!.caps).toEqual(["Net"]);
  });

  it("validate_card: card param is lend — CardDetails not in Result<AuthToken, ...>", () => {
    const sig = env.functions.get("validate_card");
    expect(sig).toBeDefined();
    expect(sig!.params[0]).toMatchObject({ name: "card", mode: "lend" });
  });

  it("validate_card: returnType ok is a resource (AuthToken), err is plain", () => {
    expect.assertions(4);
    const sig = env.functions.get("validate_card");
    expect(sig).toBeDefined();
    const ret = sig!.returnType;
    expect(ret.kind).toBe("result");
    if (ret.kind === "result") {
      expect(ret.ok.kind).toBe("resource");
      expect(ret.err.kind).toBe("plain");
    }
  });

  it("execute_charge has caps [Net, ChargeCard]", () => {
    const sig = env.functions.get("execute_charge");
    expect(sig).toBeDefined();
    expect(sig!.caps).toEqual(["Net", "ChargeCard"]);
  });

  it("execute_charge: token param is lend — AuthToken not in Result<Receipt, ...> (known gap)", () => {
    // execute_charge semantically consumes the auth token (one-time use), but the heuristic
    // returns lend because AuthToken does not appear in Result<Receipt, PaymentError>.
    // The checker in Step 3 will record cleanup firing for token at scope exit — a false
    // double-close event — but this does not cause the canonical program to be rejected.
    const sig = env.functions.get("execute_charge");
    expect(sig).toBeDefined();
    expect(sig!.params[0]).toMatchObject({ name: "token", mode: "lend" });
  });
});

describe("buildTypeEnv — smtp.fit", () => {
  let env!: TypeEnv;
  beforeAll(() => {
    const src = fs.readFileSync(path.join(__dirname, "smtp.fit"), "utf8");
    env = buildTypeEnv(parse(src, "smtp.fit"));
  });

  it("registers SmtpConn as a resource with typeParam S", () => {
    expect(env.resources.get("SmtpConn")).toEqual({
      name: "SmtpConn", typeParam: "S", cleanup: "tcp_force_close", fallback: false,
    });
  });

  it("registers SessionError alias with members [SmtpError, IoError]", () => {
    expect(env.aliases.get("SessionError")).toEqual(["SmtpError", "IoError"]);
  });

  it("connect: host param is lend — String not in Result<SmtpConn<Fresh>, ...>", () => {
    const sig = env.functions.get("connect");
    expect(sig).toBeDefined();
    expect(sig!.params[0]).toMatchObject({ name: "host", mode: "lend" });
  });

  it("greet: c param is move — SmtpConn appears in Result<SmtpConn<Greeted>, ...>", () => {
    const sig = env.functions.get("greet");
    expect(sig).toBeDefined();
    expect(sig!.params[0]).toMatchObject({ name: "c", mode: "move" });
  });

  it("auth: c is move, creds is lend", () => {
    const sig = env.functions.get("auth");
    expect(sig).toBeDefined();
    expect(sig!.params[0]).toMatchObject({ name: "c",     mode: "move" });
    expect(sig!.params[1]).toMatchObject({ name: "creds", mode: "lend" });
  });

  it("send_message: c is lend — SmtpConn not in Result<(), ...> (correct)", () => {
    const sig = env.functions.get("send_message");
    expect(sig).toBeDefined();
    expect(sig!.params[0]).toMatchObject({ name: "c", mode: "lend" });
  });

  it("close: c is lend — SmtpConn not in Result<(), ...> (known gap: close actually consumes c)", () => {
    const sig = env.functions.get("close");
    expect(sig).toBeDefined();
    expect(sig!.params[0]).toMatchObject({ name: "c", mode: "lend" });
  });

  it("greet: returnType ok is SmtpConn<Greeted> resource", () => {
    expect.assertions(3);
    const sig = env.functions.get("greet");
    expect(sig).toBeDefined();
    const ret = sig!.returnType;
    expect(ret.kind).toBe("result");
    if (ret.kind === "result") {
      expect(ret.ok).toEqual({
        kind: "resource", mode: "linear",
        name: "SmtpConn", typeState: "Greeted", cleanup: "tcp_force_close", fallback: false,
      });
    }
  });

  it("deliver_batch: c is lend — SmtpConn not in Result<(), ...>", () => {
    const sig = env.functions.get("deliver_batch");
    expect(sig).toBeDefined();
    expect(sig!.params[0]).toMatchObject({ name: "c", mode: "lend" });
  });

  it("run_session: returnType is Result<unit, SessionError alias>", () => {
    expect.assertions(4);
    const sig = env.functions.get("run_session");
    expect(sig).toBeDefined();
    const ret = sig!.returnType;
    expect(ret.kind).toBe("result");
    if (ret.kind === "result") {
      expect(ret.ok.kind).toBe("unit");
      expect(ret.err).toEqual({ kind: "alias", mode: "unrestricted", name: "SessionError", members: ["SmtpError", "IoError"] });
    }
  });
});

describe("buildTypeEnv — edge cases", () => {
  it("handles empty program — all maps empty", () => {
    const env = buildTypeEnv({ decls: [] });
    expect(env.resources.size).toBe(0);
    expect(env.aliases.size).toBe(0);
    expect(env.functions.size).toBe(0);
  });

  it("registers zero-param function with empty params array", () => {
    const prog = parse("fn noop() -> ()", "test.fit");
    const env  = buildTypeEnv(prog);
    const sig  = env.functions.get("noop");
    expect(sig).toBeDefined();
    expect(sig!.params).toHaveLength(0);
    expect(sig!.returnType).toEqual({ kind: "unit", mode: "unrestricted" });
  });

  it("registers resource with fallback cleanup correctly", () => {
    const prog = parse("resource R { f: X, cleanup: fallback force_close }", "test.fit");
    const env  = buildTypeEnv(prog);
    expect(env.resources.get("R")).toEqual({
      name: "R", typeParam: null, cleanup: "force_close", fallback: true,
    });
  });

  it("record type in function signature resolves to plain unrestricted", () => {
    // records are not in the resources map — the checker handles transitively-linear
    // records in Step 3; here they correctly resolve as plain unrestricted.
    const prog = parse("record Pt { x: Int } fn origin() -> Pt", "test.fit");
    const env  = buildTypeEnv(prog);
    const sig  = env.functions.get("origin");
    expect(sig).toBeDefined();
    expect(sig!.returnType).toEqual({ kind: "plain", mode: "unrestricted", name: "Pt" });
  });
});
