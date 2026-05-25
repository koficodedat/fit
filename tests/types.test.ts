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
});
