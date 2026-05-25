# Type Representation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/types.ts` — FIT's type representation layer that maps AST types to semantic FitTypes, infers lend/move for function parameters, and constructs a global TypeEnv from a parsed program.

**Architecture:** Single file `src/types.ts` exports six structural types (`FitType`, `ResolveEnv`, `ResourceInfo`, `ResolvedParam`, `FunctionSig`, `TypeEnv`) and three functions (`resolveType`, `inferParamMode`, `buildTypeEnv`). `resolveType` takes a `ResolveEnv` (only resources + aliases — never functions) to make the two-pass construction in `buildTypeEnv` safe by design. `buildTypeEnv` does two passes: pass 1 collects resources and aliases, pass 2 resolves all function signatures. Undeclared types default to unrestricted (per FIT-SPEC-v2.md §2.1 and the design spec's undeclared-symbol policy).

**Tech Stack:** TypeScript, Jest + ts-jest, `src/ast.ts` (existing), parsed canonical programs in `tests/payment.fit` and `tests/smtp.fit`.

---

### Task 1: Data structures

**Files:**
- Create: `src/types.ts`
- Create: `tests/types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

```
npx jest tests/types.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '../src/types'`

- [ ] **Step 3: Create `src/types.ts` with data structures and stubs**

Note: `TypeEnv` is declared before `ResolveEnv` so that `Pick<TypeEnv, ...>` does not forward-reference an unseen type.

```typescript
import { Program, Type } from "./ast";

export type MemoryMode = "unrestricted" | "linear";
export type ParamMode  = "lend" | "move";

// mode is derivable from kind (resource → linear, all others → unrestricted).
// Kept for spec-terminology alignment — use t.mode === "linear" in checker code.
// Do not add a separate isLinear() helper.
export type FitType =
  | { kind: "plain";    mode: "unrestricted"; name: string }
  | { kind: "resource"; mode: "linear";       name: string; typeState: string | null; cleanup: string; fallback: boolean }
  | { kind: "result";   mode: "unrestricted"; ok: FitType; err: FitType }
  | { kind: "unit";     mode: "unrestricted" }
  | { kind: "alias";    mode: "unrestricted"; name: string; members: string[] };

// name is redundant with the Map key in TypeEnv — kept so these types are self-contained
// when passed around without their Map context.
export type ResourceInfo  = { name: string; typeParam: string | null; cleanup: string; fallback: boolean };
export type ResolvedParam = { name: string; type_: FitType; mode: ParamMode };
export type FunctionSig   = { name: string; params: ResolvedParam[]; caps: string[]; returnType: FitType };

export type TypeEnv    = { resources: Map<string, ResourceInfo>; aliases: Map<string, string[]>; functions: Map<string, FunctionSig> };
// ResolveEnv is the subset of TypeEnv that resolveType needs.
// Using Pick here prevents resolveType from accidentally reading a partially-built
// functions map during buildTypeEnv's two-pass construction.
export type ResolveEnv = Pick<TypeEnv, "resources" | "aliases">;

export function resolveType(_ast: Type, _env: ResolveEnv): FitType {
  throw new Error("not implemented");
}

export function inferParamMode(_paramBaseName: string, _returnType: Type): ParamMode {
  throw new Error("not implemented");
}

export function buildTypeEnv(_program: Program): TypeEnv {
  throw new Error("not implemented");
}
```

- [ ] **Step 4: Run test to verify it passes**

```
npx jest tests/types.test.ts --no-coverage
```

Expected: PASS — 10 tests pass (data-structure construction + `typeof` checks)

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat(step2): add FIT type representation data structures"
```

---

### Task 2: resolveType

**Files:**
- Modify: `src/types.ts` — implement `resolveType`
- Modify: `tests/types.test.ts` — add resolveType tests

- [ ] **Step 1: Write the failing tests**

Add after the first `describe` block in `tests/types.test.ts`. Note that `testEnv` is declared inside the describe callback so it stays scoped to the resolveType tests.

```typescript
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
```

- [ ] **Step 2: Run tests to verify new tests fail**

```
npx jest tests/types.test.ts --no-coverage
```

Expected: FAIL — `resolveType` tests throw `Error: not implemented`

- [ ] **Step 3: Implement `resolveType` in `src/types.ts`**

Replace the `resolveType` stub with:

```typescript
export function resolveType(ast: Type, env: ResolveEnv): FitType {
  switch (ast.kind) {
    case "unit":
      return { kind: "unit", mode: "unrestricted" };
    case "result": {
      const ok  = resolveType(ast.ok,  env);
      const err = resolveType(ast.err, env);
      return { kind: "result", mode: "unrestricted", ok, err };
    }
    case "named": {
      const resource = env.resources.get(ast.name);
      if (resource) {
        // typeArg?.kind === "named" relies on parser invariant: typestate args are always identifiers.
        const typeState = ast.typeArg?.kind === "named" ? ast.typeArg.name : null;
        return { kind: "resource", mode: "linear", name: ast.name, typeState, cleanup: resource.cleanup, fallback: resource.fallback };
      }
      const alias = env.aliases.get(ast.name);
      if (alias) {
        return { kind: "alias", mode: "unrestricted", name: ast.name, members: alias };
      }
      return { kind: "plain", mode: "unrestricted", name: ast.name };
    }
  }
}
```

- [ ] **Step 4: Run tests to verify all pass**

```
npx jest tests/types.test.ts --no-coverage
```

Expected: PASS — 19 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat(step2): implement resolveType"
```

---

### Task 3: inferParamMode

**Files:**
- Modify: `src/types.ts` — add `typeContainsName` helper, implement `inferParamMode`
- Modify: `tests/types.test.ts` — add inferParamMode tests

- [ ] **Step 1: Write the failing tests**

Add after the `resolveType` describe block:

```typescript
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
```

- [ ] **Step 2: Run tests to verify new tests fail**

```
npx jest tests/types.test.ts --no-coverage
```

Expected: FAIL — `inferParamMode` tests throw `Error: not implemented`

- [ ] **Step 3: Implement `typeContainsName` and `inferParamMode` in `src/types.ts`**

Add the unexported helper and replace the `inferParamMode` stub:

```typescript
// Does not expand aliases: "SessionError" would not match its member names ("SmtpError").
// In FIT, type aliases are error unions only — resource aliasing doesn't arise in the PoC,
// so alias non-expansion is an accepted limitation of the heuristic.
function typeContainsName(t: Type, name: string): boolean {
  switch (t.kind) {
    case "unit":   return false;
    case "named":  return t.name === name || (t.typeArg !== null && typeContainsName(t.typeArg, name));
    case "result": return typeContainsName(t.ok, name) || typeContainsName(t.err, name);
  }
}

export function inferParamMode(paramBaseName: string, returnType: Type): ParamMode {
  return typeContainsName(returnType, paramBaseName) ? "move" : "lend";
}
```

- [ ] **Step 4: Run tests to verify all pass**

```
npx jest tests/types.test.ts --no-coverage
```

Expected: PASS — 27 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat(step2): implement inferParamMode with typeContainsName heuristic"
```

---

### Task 4: buildTypeEnv

**Files:**
- Modify: `src/types.ts` — implement `buildTypeEnv`
- Modify: `tests/types.test.ts` — add buildTypeEnv tests using canonical programs

- [ ] **Step 1: Write the failing tests**

Add the following imports at the top of `tests/types.test.ts`, after the existing imports:

```typescript
import * as fs from "fs";
import * as path from "path";
import { parse } from "../src/parser";
```

Add after the `inferParamMode` describe block. Note: `beforeAll` is used in both canonical-program describes so that a failure in `buildTypeEnv` fails individual tests rather than crashing the entire collection phase. The `!` on `let env!: TypeEnv` is a definite-assignment assertion telling TypeScript that `beforeAll` guarantees initialization before any `it` runs.

```typescript
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
```

- [ ] **Step 2: Run tests to verify new tests fail**

```
npx jest tests/types.test.ts --no-coverage
```

Expected: FAIL — the three `buildTypeEnv` describe blocks each report failures because `buildTypeEnv` throws `Error: not implemented`. The 27 already-passing tests still pass.

- [ ] **Step 3: Implement `buildTypeEnv` in `src/types.ts`**

Replace the `buildTypeEnv` stub with:

```typescript
export function buildTypeEnv(program: Program): TypeEnv {
  const resources = new Map<string, ResourceInfo>();
  const aliases   = new Map<string, string[]>();
  const functions = new Map<string, FunctionSig>();

  for (const decl of program.decls) {
    if (decl.kind === "resource") {
      resources.set(decl.name, {
        name: decl.name, typeParam: decl.typeParam,
        cleanup: decl.cleanup.fn, fallback: decl.cleanup.fallback,
      });
    } else if (decl.kind === "type_alias") {
      aliases.set(decl.name, decl.members);
      // decl.members and decl.caps are stored by reference — AST is read-only after parsing.
    }
  }

  // resolveEnv intentionally excludes functions: resolveType cannot access a partially-built
  // functions map, making the two-pass boundary enforced by the type system.
  const resolveEnv: ResolveEnv = { resources, aliases };

  for (const decl of program.decls) {
    if (decl.kind === "fn") {
      const returnType = resolveType(decl.returnType, resolveEnv);
      const params: ResolvedParam[] = decl.params.map(p => {
        const type_    = resolveType(p.type_, resolveEnv);
        const baseName = p.type_.kind === "named" ? p.type_.name : "";
        const mode     = inferParamMode(baseName, decl.returnType);
        return { name: p.name, type_, mode };
      });
      functions.set(decl.name, { name: decl.name, params, caps: decl.caps, returnType });
    }
  }

  return { resources, aliases, functions };
}
```

- [ ] **Step 4: Run all tests — parser suite and types suite**

```
npx jest --no-coverage
```

Expected: PASS — all tests pass (parser suite + 48 types tests)

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat(step2): implement buildTypeEnv — two-pass type environment construction"
```
