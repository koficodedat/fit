// tests/types.test.ts
import {
  FitType, ResolveEnv, TypeEnv,
  resolveType, inferParamMode, buildTypeEnv,
} from "../src/types";
import { Type } from "../src/ast";

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
