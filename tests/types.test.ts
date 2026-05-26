// tests/types.test.ts
import { FitType, BuildError, ResolveEnv, TypeEnv, resolveType, buildTypeEnv } from "../src/types";
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
      kind: "resource",
      mode: "linear",
      name: "AuthToken",
      typeState: null,
      cleanup: "void_token",
      fallback: false,
    };
    expect(t.kind).toBe("resource");
  });

  it("can construct a FitType.result value", () => {
    const ok: FitType = { kind: "plain", mode: "unrestricted", name: "Receipt" };
    const err: FitType = { kind: "plain", mode: "unrestricted", name: "PaymentError" };
    const t: FitType = { kind: "result", mode: "unrestricted", ok, err };
    expect(t.kind).toBe("result");
  });

  it("can construct a FitType.unit value", () => {
    const t: FitType = { kind: "unit", mode: "unrestricted" };
    expect(t.kind).toBe("unit");
  });

  it("can construct a FitType.alias value", () => {
    const t: FitType = {
      kind: "alias",
      mode: "unrestricted",
      name: "SessionError",
      members: ["SmtpError", "IoError"],
    };
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

  it("exports BuildError type (build-time error from buildTypeEnv)", () => {
    const e: BuildError = { message: "test", pos: { line: 1, col: 1 } };
    expect(e.message).toBe("test");
  });

  it("exports buildTypeEnv as a function", () => {
    expect(typeof buildTypeEnv).toBe("function");
  });

  it("TypeEnv is structurally assignable to ResolveEnv (Pick subset relationship)", () => {
    const full: TypeEnv = { resources: new Map(), aliases: new Map(), functions: new Map() };
    const narrow: ResolveEnv = full;
    expect(narrow.resources.size).toBe(0);
  });
});

describe("resolveType", () => {
  const testEnv: ResolveEnv = {
    resources: new Map([
      ["AuthToken", { name: "AuthToken", typeParam: null, cleanup: "void_token", fallback: false }],
      [
        "SmtpConn",
        { name: "SmtpConn", typeParam: "S", cleanup: "tcp_force_close", fallback: false },
      ],
    ]),
    aliases: new Map([["SessionError", ["SmtpError", "IoError"]]]),
  };

  it("resolves unit type", () => {
    expect(resolveType({ kind: "unit" }, testEnv)).toEqual({ kind: "unit", mode: "unrestricted" });
  });

  it("resolves undeclared named type as plain unrestricted", () => {
    expect(resolveType({ kind: "named", name: "String", typeArg: null }, testEnv)).toEqual({
      kind: "plain",
      mode: "unrestricted",
      name: "String",
    });
  });

  it("resolves declared resource without typestate", () => {
    expect(resolveType({ kind: "named", name: "AuthToken", typeArg: null }, testEnv)).toEqual({
      kind: "resource",
      mode: "linear",
      name: "AuthToken",
      typeState: null,
      cleanup: "void_token",
      fallback: false,
    });
  });

  it("resolves resource with typestate argument", () => {
    const ast: Type = {
      kind: "named",
      name: "SmtpConn",
      typeArg: { kind: "named", name: "Ready", typeArg: null },
    };
    expect(resolveType(ast, testEnv)).toEqual({
      kind: "resource",
      mode: "linear",
      name: "SmtpConn",
      typeState: "Ready",
      cleanup: "tcp_force_close",
      fallback: false,
    });
  });

  it("resolves alias type", () => {
    expect(resolveType({ kind: "named", name: "SessionError", typeArg: null }, testEnv)).toEqual({
      kind: "alias",
      mode: "unrestricted",
      name: "SessionError",
      members: ["SmtpError", "IoError"],
    });
  });

  it("resolves Result<AuthToken, PaymentError> — ok is resource, err is plain", () => {
    const ast: Type = {
      kind: "result",
      ok: { kind: "named", name: "AuthToken", typeArg: null },
      err: { kind: "named", name: "PaymentError", typeArg: null },
    };
    expect(resolveType(ast, testEnv)).toEqual({
      kind: "result",
      mode: "unrestricted",
      ok: {
        kind: "resource",
        mode: "linear",
        name: "AuthToken",
        typeState: null,
        cleanup: "void_token",
        fallback: false,
      },
      err: { kind: "plain", mode: "unrestricted", name: "PaymentError" },
    });
  });

  it("resolves Result<(), SessionError> — ok is unit, err is alias", () => {
    const ast: Type = {
      kind: "result",
      ok: { kind: "unit" },
      err: { kind: "named", name: "SessionError", typeArg: null },
    };
    expect(resolveType(ast, testEnv)).toEqual({
      kind: "result",
      mode: "unrestricted",
      ok: { kind: "unit", mode: "unrestricted" },
      err: {
        kind: "alias",
        mode: "unrestricted",
        name: "SessionError",
        members: ["SmtpError", "IoError"],
      },
    });
  });

  it("resolves Result<(), SmtpConn<Closing>> — err branch is a resource", () => {
    const ast: Type = {
      kind: "result",
      ok: { kind: "unit" },
      err: {
        kind: "named",
        name: "SmtpConn",
        typeArg: { kind: "named", name: "Closing", typeArg: null },
      },
    };
    expect(resolveType(ast, testEnv)).toEqual({
      kind: "result",
      mode: "unrestricted",
      ok: { kind: "unit", mode: "unrestricted" },
      err: {
        kind: "resource",
        mode: "linear",
        name: "SmtpConn",
        typeState: "Closing",
        cleanup: "tcp_force_close",
        fallback: false,
      },
    });
  });

  it("resolves resource with non-named typeArg — throws on parser invariant violation", () => {
    const ast: Type = { kind: "named", name: "SmtpConn", typeArg: { kind: "unit" } };
    expect(() => resolveType(ast, testEnv)).toThrow("parser invariant violated");
  });

  it("resolves Result<Result<A, E1>, E2> — nested Result ok branch", () => {
    const ast: Type = {
      kind: "result",
      ok: {
        kind: "result",
        ok: { kind: "named", name: "A", typeArg: null },
        err: { kind: "named", name: "E1", typeArg: null },
      },
      err: { kind: "named", name: "E2", typeArg: null },
    };
    expect(resolveType(ast, testEnv)).toEqual({
      kind: "result",
      mode: "unrestricted",
      ok: {
        kind: "result",
        mode: "unrestricted",
        ok: { kind: "plain", mode: "unrestricted", name: "A" },
        err: { kind: "plain", mode: "unrestricted", name: "E1" },
      },
      err: { kind: "plain", mode: "unrestricted", name: "E2" },
    });
  });

  it("resolves alias-of-alias — members are unresolved name strings, no expansion", () => {
    // type A = B | C where B is itself a declared alias: resolveType returns A's members
    // without expanding B. alias non-expansion is an accepted PoC limitation.
    const envWithNestedAlias: ResolveEnv = {
      resources: new Map(),
      aliases: new Map([
        ["B", ["X", "Y"]],
        ["AliasOfB", ["B", "Z"]],
      ]),
    };
    expect(
      resolveType({ kind: "named", name: "AliasOfB", typeArg: null }, envWithNestedAlias)
    ).toEqual({ kind: "alias", mode: "unrestricted", name: "AliasOfB", members: ["B", "Z"] });
  });
});

describe("body-based inference via buildTypeEnv", () => {
  it("bodied function: param passed to move callee → inferred move", () => {
    const src = `
      resource Token { id: TokenId, cleanup: void_token }
      fn consume(t: move Token) -> ()
      fn wrapper(t: Token) -> () {
          consume(t)
      }
    `;
    const { env } = buildTypeEnv(parse(src, "t.fit"));
    expect(env.functions.get("wrapper")!.params[0]).toMatchObject({ name: "t", mode: "move" });
  });

  it("bodied function: param only passed to lend callees → inferred lend", () => {
    const src = `
      resource Conn { sock: X, cleanup: force_close }
      fn read(c: lend Conn) -> String
      fn process(c: Conn) -> () {
          read(c)
      }
    `;
    const { env } = buildTypeEnv(parse(src, "t.fit"));
    expect(env.functions.get("process")!.params[0]).toMatchObject({ name: "c", mode: "lend" });
  });

  it("bodied function: param returned via Ok → inferred move", () => {
    const src = `
      resource Token { id: TokenId, cleanup: void_token }
      fn wrap(t: Token) -> Result<Token, Error> {
          Ok(t)
      }
    `;
    const { env } = buildTypeEnv(parse(src, "t.fit"));
    expect(env.functions.get("wrap")!.params[0]).toMatchObject({ name: "t", mode: "move" });
  });

  it("bodied function: explicit annotation overrides body inference", () => {
    const src = `
      resource Conn { sock: X, cleanup: force_close }
      fn use_it(c: lend Conn) -> () {
          drop(c)
      }
    `;
    // Annotation says lend; body says move (drop). Annotation wins.
    const { env } = buildTypeEnv(parse(src, "t.fit"));
    expect(env.functions.get("use_it")!.params[0]).toMatchObject({ name: "c", mode: "lend" });
  });

  it("extern with move annotation → mode is move", () => {
    const src = `
      resource Conn { sock: X, cleanup: force_close }
      fn close(c: move Conn) -> ()
    `;
    const { env } = buildTypeEnv(parse(src, "t.fit"));
    expect(env.functions.get("close")!.params[0]).toMatchObject({ name: "c", mode: "move" });
  });

  it("extern with lend annotation → mode is lend", () => {
    const src = `
      resource Conn { sock: X, cleanup: force_close }
      fn read(c: lend Conn) -> String
    `;
    const { env } = buildTypeEnv(parse(src, "t.fit"));
    expect(env.functions.get("read")!.params[0]).toMatchObject({ name: "c", mode: "lend" });
  });

  it("extern linear param without annotation → buildError emitted, mode defaults to lend", () => {
    const src = `
      resource Conn { sock: X, cleanup: force_close }
      fn close(c: Conn) -> ()
    `;
    const { env, buildErrors } = buildTypeEnv(parse(src, "t.fit"));
    expect(buildErrors).toHaveLength(1);
    expect(buildErrors[0].message).toContain("extern 'close'");
    expect(buildErrors[0].message).toContain("linear parameter 'c'");
    expect(buildErrors[0].message).toContain("no move/lend annotation");
    expect(env.functions.get("close")!.params[0].mode).toBe("lend");
  });

  it("extern non-linear param without annotation → no error", () => {
    const src = `fn greet(name: String) -> ()`;
    const { buildErrors } = buildTypeEnv(parse(src, "t.fit"));
    expect(buildErrors).toHaveLength(0);
  });
});

describe("buildTypeEnv — payment.fit", () => {
  let env!: TypeEnv;
  beforeAll(() => {
    const src = fs.readFileSync(path.join(__dirname, "payment.fit"), "utf8");
    env = buildTypeEnv(parse(src, "payment.fit")).env;
  });

  it("registers AuthToken as a linear resource with cleanup void_token", () => {
    expect(env.resources.get("AuthToken")).toEqual({
      name: "AuthToken",
      typeParam: null,
      cleanup: "void_token",
      fallback: false,
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

  it("execute_charge: token param is move — annotated explicitly in payment.fit", () => {
    const sig = env.functions.get("execute_charge");
    expect(sig).toBeDefined();
    expect(sig!.params[0]).toMatchObject({ name: "token", mode: "move" });
  });
});

describe("buildTypeEnv — smtp.fit", () => {
  let env!: TypeEnv;
  beforeAll(() => {
    const src = fs.readFileSync(path.join(__dirname, "smtp.fit"), "utf8");
    env = buildTypeEnv(parse(src, "smtp.fit")).env;
  });

  it("registers SmtpConn as a resource with typeParam S", () => {
    expect(env.resources.get("SmtpConn")).toEqual({
      name: "SmtpConn",
      typeParam: "S",
      cleanup: "tcp_force_close",
      fallback: false,
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

  it("greet: c param is move — annotated explicitly in smtp.fit", () => {
    const sig = env.functions.get("greet");
    expect(sig).toBeDefined();
    expect(sig!.params[0]).toMatchObject({ name: "c", mode: "move" });
  });

  it("auth: c is move, creds is lend", () => {
    const sig = env.functions.get("auth");
    expect(sig).toBeDefined();
    expect(sig!.params[0]).toMatchObject({ name: "c", mode: "move" });
    expect(sig!.params[1]).toMatchObject({ name: "creds", mode: "lend" });
  });

  it("send_message: c is lend — annotated explicitly in smtp.fit", () => {
    const sig = env.functions.get("send_message");
    expect(sig).toBeDefined();
    expect(sig!.params[0]).toMatchObject({ name: "c", mode: "lend" });
  });

  it("close: c is move — annotated explicitly in smtp.fit", () => {
    const sig = env.functions.get("close");
    expect(sig).toBeDefined();
    expect(sig!.params[0]).toMatchObject({ name: "c", mode: "move" });
  });

  it("greet: returnType ok is SmtpConn<Greeted> resource", () => {
    expect.assertions(3);
    const sig = env.functions.get("greet");
    expect(sig).toBeDefined();
    const ret = sig!.returnType;
    expect(ret.kind).toBe("result");
    if (ret.kind === "result") {
      expect(ret.ok).toEqual({
        kind: "resource",
        mode: "linear",
        name: "SmtpConn",
        typeState: "Greeted",
        cleanup: "tcp_force_close",
        fallback: false,
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
      expect(ret.err).toEqual({
        kind: "alias",
        mode: "unrestricted",
        name: "SessionError",
        members: ["SmtpError", "IoError"],
      });
    }
  });
});

describe("buildTypeEnv — edge cases", () => {
  it("handles empty program — all maps empty", () => {
    const { env } = buildTypeEnv({ decls: [] });
    expect(env.resources.size).toBe(0);
    expect(env.aliases.size).toBe(0);
    expect(env.functions.size).toBe(0);
  });

  it("registers zero-param function with empty params array", () => {
    const prog = parse("fn noop() -> ()", "test.fit");
    const { env } = buildTypeEnv(prog);
    const sig = env.functions.get("noop");
    expect(sig).toBeDefined();
    expect(sig!.params).toHaveLength(0);
    expect(sig!.returnType).toEqual({ kind: "unit", mode: "unrestricted" });
  });

  it("registers resource with fallback cleanup correctly", () => {
    const prog = parse("resource R { f: X, cleanup: fallback force_close }", "test.fit");
    const { env } = buildTypeEnv(prog);
    expect(env.resources.get("R")).toEqual({
      name: "R",
      typeParam: null,
      cleanup: "force_close",
      fallback: true,
    });
  });

  it("record type in function signature resolves to plain unrestricted", () => {
    // records are not in the resources map — the checker handles transitively-linear
    // records in Step 3; here they correctly resolve as plain unrestricted.
    const prog = parse("record Pt { x: Int } fn origin() -> Pt", "test.fit");
    const { env } = buildTypeEnv(prog);
    const sig = env.functions.get("origin");
    expect(sig).toBeDefined();
    expect(sig!.returnType).toEqual({ kind: "plain", mode: "unrestricted", name: "Pt" });
  });

  it("duplicate resource name — second decl silently overwrites first", () => {
    // Known behavior: buildTypeEnv does not enforce name uniqueness.
    // Step 3 (checker) is responsible for catching duplicate declarations.
    const prog = parse(
      "resource Conn { sock: X, cleanup: close_a } resource Conn { sock: Y, cleanup: close_b }",
      "test.fit"
    );
    const { env } = buildTypeEnv(prog);
    expect(env.resources.get("Conn")).toMatchObject({ cleanup: "close_b" });
  });

  it("duplicate fn name — second decl silently overwrites first", () => {
    const prog = parse("fn greet() -> () fn greet(x: Int) -> ()", "test.fit");
    const { env } = buildTypeEnv(prog);
    const sig = env.functions.get("greet");
    expect(sig).toBeDefined();
    expect(sig!.params).toHaveLength(1); // second decl wins
  });

  it("zero-param function with resource return type", () => {
    const prog = parse("resource Conn { sock: X, cleanup: close } fn create() -> Conn", "test.fit");
    const { env } = buildTypeEnv(prog);
    const sig = env.functions.get("create");
    expect(sig).toBeDefined();
    expect(sig!.params).toHaveLength(0);
    expect(sig!.returnType).toEqual({
      kind: "resource",
      mode: "linear",
      name: "Conn",
      typeState: null,
      cleanup: "close",
      fallback: false,
    });
  });

  it("fn with Result-typed param — non-resource, mode is lend", () => {
    // Result-typed params are not resources; move/lend distinction is irrelevant.
    // Always classified as lend regardless of body or annotation.
    const prog = parse("fn unwrap(r: Result<A, B>) -> ()", "test.fit");
    const { env } = buildTypeEnv(prog);
    const sig = env.functions.get("unwrap");
    expect(sig).toBeDefined();
    expect(sig!.params[0]).toMatchObject({ name: "r", mode: "lend" });
  });

  it("enum and record decls are silently ignored — not registered as resources or aliases", () => {
    const prog = parse(
      "enum Color { Red, Green } record Point { x: Int } fn noop() -> ()",
      "test.fit"
    );
    const { env } = buildTypeEnv(prog);
    expect(env.resources.has("Color")).toBe(false);
    expect(env.resources.has("Point")).toBe(false);
    expect(env.aliases.has("Color")).toBe(false);
    expect(env.aliases.has("Point")).toBe(false);
    expect(env.functions.has("noop")).toBe(true);
  });

  it("fn with plain (undeclared) return type resolves to plain unrestricted in FunctionSig", () => {
    // Ensures buildTypeEnv.returnType goes through resolveType, not raw AST passthrough.
    const prog = parse("fn describe(x: Int) -> SomeUndeclaredType", "test.fit");
    const { env } = buildTypeEnv(prog);
    const sig = env.functions.get("describe");
    expect(sig).toBeDefined();
    expect(sig!.returnType).toEqual({
      kind: "plain",
      mode: "unrestricted",
      name: "SomeUndeclaredType",
    });
  });

  it("alias name collision with resource name — resource takes precedence", () => {
    // resources are checked before aliases in resolveType; if both maps have the same key,
    // the resource wins. This precedence is a named invariant, not an accident.
    const prog = parse(
      "resource Dual { f: X, cleanup: cleanup_fn } type Dual = A | B fn use_it(d: Dual) -> ()",
      "test.fit"
    );
    const { env } = buildTypeEnv(prog);
    const sig = env.functions.get("use_it");
    expect(sig).toBeDefined();
    expect(sig!.params[0].type_.kind).toBe("resource");
  });

  it("fn using undeclared capability — caps stored verbatim, no validation in Step 2", () => {
    // buildTypeEnv defers capability validation to Step 4 (capability checker).
    // An undeclared cap name passes through without error.
    const prog = parse("fn sensitive() using UndeclaredCap -> ()", "test.fit");
    const { env } = buildTypeEnv(prog);
    const sig = env.functions.get("sensitive");
    expect(sig).toBeDefined();
    expect(sig!.caps).toEqual(["UndeclaredCap"]);
  });
});
