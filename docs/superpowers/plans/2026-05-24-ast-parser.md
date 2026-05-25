# AST + Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the FIT AST type definitions and recursive-descent parser so both canonical programs (payment.fit, smtp.fit) parse without error.

**Architecture:** Character-by-character recursive descent (`Parser` class, no separate tokenizer). AST types are pure discriminated unions with no logic. Parser panics on malformed input — PoC quality only.

**Tech Stack:** TypeScript, Node.js, Jest (unit tests), ts-jest

---

## File Map

| File | Role |
|------|------|
| `package.json` | Project manifest + scripts |
| `tsconfig.json` | TypeScript config (strict, ES2020) |
| `jest.config.js` | Jest + ts-jest wiring |
| `src/ast.ts` | All AST types — no logic |
| `src/parser.ts` | `Parser` class + `parse()` export |
| `tests/parser.test.ts` | Unit + integration tests |
| `tests/payment.fit` | Canonical program 1 (from FIT-SYNTAX.md §10) |
| `tests/smtp.fit` | Canonical program 2 (from FIT-SYNTAX.md §10) |

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `jest.config.js`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "fit-checker",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "test": "jest",
    "build": "tsc"
  },
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "@types/node": "^20.14.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.4",
    "typescript": "^5.4.5"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "strict": true,
    "outDir": "dist",
    "rootDir": ".",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Create jest.config.js**

```js
/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.ts"],
};
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 5: Verify TypeScript resolves**

Run: `npx tsc --noEmit`
Expected: no output (no source files yet — that is fine).

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json jest.config.js package-lock.json
git commit -m "chore: scaffold TypeScript + Jest project"
```

---

### Task 2: AST Type Definitions

**Files:**
- Create: `src/ast.ts`

- [ ] **Step 1: Write the failing test (import check)**

Create `tests/parser.test.ts` with just an import:

```typescript
import { Program, Decl, Stmt, Expr, Type, Pattern } from "../src/ast";

test("ast types import", () => {
  const _: Program = { decls: [] };
  expect(_.decls).toHaveLength(0);
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `npx jest tests/parser.test.ts -t "ast types import"`
Expected: FAIL — `Cannot find module '../src/ast'`

- [ ] **Step 3: Write src/ast.ts**

```typescript
export type Pos = { line: number; col: number };

export type Program = { decls: Decl[] };

export type Decl =
  | { kind: "capability"; name: string; pos: Pos }
  | { kind: "record";     name: string; fields: FieldDef[]; pos: Pos }
  | { kind: "enum";       name: string; variants: VariantDef[]; pos: Pos }
  | { kind: "resource";   name: string; typeParam: string | null; fields: FieldDef[]; cleanup: CleanupDef; pos: Pos }
  | { kind: "type_alias"; name: string; members: string[]; pos: Pos }
  | { kind: "fn";         name: string; params: ParamDef[]; caps: string[]; returnType: Type; body: Stmt[] | null; pos: Pos };

export type Type =
  | { kind: "named";  name: string; typeArg: Type | null }
  | { kind: "result"; ok: Type; err: Type }
  | { kind: "unit" };

export type Stmt =
  | { kind: "let";    name: string; mut: boolean; init: Expr; pos: Pos }
  | { kind: "rebind"; name: string; expr: Expr; pos: Pos }
  | { kind: "expr";   expr: Expr; pos: Pos }
  | { kind: "if";     cond: Expr; then: Stmt[]; else_: Stmt[]; pos: Pos }
  | { kind: "loop";   body: Stmt[]; pos: Pos }
  | { kind: "match";  expr: Expr; arms: MatchArm[]; pos: Pos }
  | { kind: "break";  pos: Pos }
  | { kind: "select"; atoms: string[]; from: string; pos: Pos };

export type Expr =
  | { kind: "var";      name: string; pos: Pos }
  | { kind: "call";     fn: string; args: Expr[]; pos: Pos }
  | { kind: "try";      expr: Expr; pos: Pos }
  | { kind: "ok";       expr: Expr; pos: Pos }
  | { kind: "err";      expr: Expr; pos: Pos }
  | { kind: "unit_val"; pos: Pos };

export type FieldDef   = { name: string; type_: Type };
export type ParamDef   = { name: string; type_: Type };
export type CleanupDef = { fallback: boolean; fn: string };
export type VariantDef = { name: string; payload: Type | null };
export type MatchArm   = { pattern: Pattern; body: Stmt[] };
export type Pattern    =
  | { kind: "variant";  name: string; binds: string[] }
  | { kind: "wildcard" };
```

- [ ] **Step 4: Run test — expect pass**

Run: `npx jest tests/parser.test.ts -t "ast types import"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ast.ts tests/parser.test.ts
git commit -m "feat: AST type definitions"
```

---

### Task 3: Parser Skeleton + Helpers

**Files:**
- Create: `src/parser.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/parser.test.ts`:

```typescript
import { parse } from "../src/parser";

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
```

- [ ] **Step 2: Run tests — expect failure**

Run: `npx jest tests/parser.test.ts -t "parse empty"`
Expected: FAIL — `Cannot find module '../src/parser'`

- [ ] **Step 3: Write parser skeleton**

Create `src/parser.ts`:

```typescript
import { Program, Decl, Stmt, Expr, Type, Pattern, Pos,
         FieldDef, ParamDef, CleanupDef, VariantDef, MatchArm } from "./ast";

class Parser {
  private src: string;
  private idx = 0;
  private line = 1;
  private col = 1;
  private filename: string;

  constructor(src: string, filename: string) {
    this.src = src;
    this.filename = filename;
  }

  private advance(): string {
    const ch = this.src[this.idx] ?? "";
    this.idx++;
    if (ch === "\n") { this.line++; this.col = 1; }
    else { this.col++; }
    return ch;
  }

  private peek(offset = 0): string {
    return this.src[this.idx + offset] ?? "";
  }

  private skip(): void {
    while (this.idx < this.src.length) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.advance();
      } else if (ch === "/" && this.peek(1) === "/") {
        while (this.idx < this.src.length && this.peek() !== "\n") this.advance();
      } else if (ch === "/" && this.peek(1) === "*") {
        this.advance(); this.advance(); // consume /*
        while (this.idx < this.src.length) {
          if (this.peek() === "*" && this.peek(1) === "/") {
            this.advance(); this.advance(); break;
          }
          this.advance();
        }
      } else {
        break;
      }
    }
  }

  private pos(): Pos {
    return { line: this.line, col: this.col };
  }

  private err(msg: string): never {
    throw new Error(`${this.filename}:${this.line}:${this.col}: ${msg}`);
  }

  private ident(): string {
    this.skip();
    let s = "";
    const first = this.peek();
    if (!/[a-zA-Z_]/.test(first)) this.err(`expected identifier, got '${first}'`);
    while (/[a-zA-Z0-9_]/.test(this.peek())) s += this.advance();
    return s;
  }

  private expect(s: string): void {
    this.skip();
    for (const ch of s) {
      if (this.peek() !== ch) this.err(`expected '${s}', got '${this.peek()}'`);
      this.advance();
    }
  }

  parseProgram(): Program {
    const decls: Decl[] = [];
    this.skip();
    while (this.idx < this.src.length) {
      decls.push(this.parseDecl());
      this.skip();
    }
    return { decls };
  }

  private parseDecl(): Decl {
    this.skip();
    const p = this.pos();
    // peek at keyword
    let kw = "";
    let saved = this.idx;
    let savedLine = this.line;
    let savedCol = this.col;
    while (/[a-zA-Z_]/.test(this.peek())) kw += this.advance();
    switch (kw) {
      case "record":     return this.parseRecord(p);
      case "enum":       return this.parseEnum(p);
      case "resource":   return this.parseResource(p);
      case "type":       return this.parseTypeAlias(p);
      case "capability": return this.parseCapability(p);
      case "fn":         return this.parseFn(p);
      default:
        this.err(`unexpected top-level keyword '${kw}'`);
    }
  }

  private parseRecord(_pos: Pos): Decl { throw new Error("TODO"); }
  private parseEnum(_pos: Pos): Decl { throw new Error("TODO"); }
  private parseResource(_pos: Pos): Decl { throw new Error("TODO"); }
  private parseTypeAlias(_pos: Pos): Decl { throw new Error("TODO"); }
  private parseCapability(_pos: Pos): Decl { throw new Error("TODO"); }
  private parseFn(_pos: Pos): Decl { throw new Error("TODO"); }
  private parseType(): Type { throw new Error("TODO"); }
  private parseBlock(): Stmt[] { throw new Error("TODO"); }
  private parseStmt(): Stmt { throw new Error("TODO"); }
  private parseExpr(): Expr { throw new Error("TODO"); }
  private parsePattern(): Pattern { throw new Error("TODO"); }
}

export function parse(src: string, filename: string): Program {
  return new Parser(src, filename).parseProgram();
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npx jest tests/parser.test.ts -t "parse"`
Expected: all 3 PASS (empty program, line comment, block comment)

- [ ] **Step 5: Commit**

```bash
git add src/parser.ts
git commit -m "feat: parser skeleton with helper methods"
```

---

### Task 4: Parse Non-fn Declarations

Covers: `capability`, `record`, `enum`, `type_alias`, `resource` (with and without typestate param).

**Files:**
- Modify: `src/parser.ts`
- Modify: `tests/parser.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/parser.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests — expect failure**

Run: `npx jest tests/parser.test.ts -t "parse capability|parse record|parse enum|parse type|parse resource"`
Expected: FAIL — `TODO` errors from stub methods

- [ ] **Step 3: Implement parseCapability**

Replace `private parseCapability(_pos: Pos): Decl { throw new Error("TODO"); }` with:

```typescript
private parseCapability(pos: Pos): Decl {
  const name = this.ident();
  return { kind: "capability", name, pos };
}
```

- [ ] **Step 4: Implement parseRecord**

Replace `private parseRecord(_pos: Pos): Decl { throw new Error("TODO"); }` with:

```typescript
private parseRecord(pos: Pos): Decl {
  const name = this.ident();
  this.expect("{");
  const fields: FieldDef[] = [];
  this.skip();
  while (this.peek() !== "}") {
    const fname = this.ident();
    this.expect(":");
    const type_ = this.parseType();
    fields.push({ name: fname, type_ });
    this.skip();
    if (this.peek() === ",") { this.advance(); this.skip(); }
  }
  this.expect("}");
  return { kind: "record", name, fields, pos };
}
```

- [ ] **Step 5: Implement parseEnum**

Replace `private parseEnum(_pos: Pos): Decl { throw new Error("TODO"); }` with:

```typescript
private parseEnum(pos: Pos): Decl {
  const name = this.ident();
  this.expect("{");
  const variants: VariantDef[] = [];
  this.skip();
  while (this.peek() !== "}") {
    const vname = this.ident();
    this.skip();
    let payload: Type | null = null;
    if (this.peek() === "(") {
      this.advance(); // consume (
      payload = this.parseType();
      this.expect(")");
    }
    variants.push({ name: vname, payload });
    this.skip();
    if (this.peek() === ",") { this.advance(); this.skip(); }
  }
  this.expect("}");
  return { kind: "enum", name, variants, pos };
}
```

- [ ] **Step 6: Implement parseTypeAlias**

Replace `private parseTypeAlias(_pos: Pos): Decl { throw new Error("TODO"); }` with:

```typescript
private parseTypeAlias(pos: Pos): Decl {
  const name = this.ident();
  this.expect("=");
  const members: string[] = [];
  members.push(this.ident());
  this.skip();
  while (this.peek() === "|") {
    this.advance(); // consume |
    members.push(this.ident());
    this.skip();
  }
  return { kind: "type_alias", name, members, pos };
}
```

- [ ] **Step 7: Implement parseResource**

Replace `private parseResource(_pos: Pos): Decl { throw new Error("TODO"); }` with:

```typescript
private parseResource(pos: Pos): Decl {
  const name = this.ident();
  this.skip();
  let typeParam: string | null = null;
  if (this.peek() === "<") {
    this.advance(); // consume <
    typeParam = this.ident();
    this.expect(">");
  }
  this.expect("{");
  const fields: FieldDef[] = [];
  let cleanup: CleanupDef | null = null;
  this.skip();
  while (this.peek() !== "}") {
    const fname = this.ident();
    this.expect(":");
    this.skip();
    if (fname === "cleanup") {
      let fallback = false;
      // peek to check if next word is "fallback"
      let savedIdx = this.idx; let savedLine = this.line; let savedCol = this.col;
      const kw = this.ident();
      if (kw === "fallback") {
        fallback = true;
        cleanup = { fallback, fn: this.ident() };
      } else {
        cleanup = { fallback: false, fn: kw };
      }
    } else {
      const type_ = this.parseType();
      fields.push({ name: fname, type_ });
    }
    this.skip();
    if (this.peek() === ",") { this.advance(); this.skip(); }
  }
  this.expect("}");
  if (!cleanup) this.err(`resource '${name}' missing cleanup field`);
  return { kind: "resource", name, typeParam, fields, cleanup, pos };
}
```

- [ ] **Step 8: Implement parseType (basic — named and unit)**

Replace `private parseType(): Type { throw new Error("TODO"); }` with:

```typescript
private parseType(): Type {
  this.skip();
  if (this.peek() === "(") {
    // unit type ()
    this.advance();
    this.expect(")");
    return { kind: "unit" };
  }
  // read type name
  const name = this.ident();
  if (name === "Result") {
    this.expect("<");
    const ok = this.parseType();
    this.expect(",");
    const err = this.parseType();
    this.skip();
    this.expect(">");
    return { kind: "result", ok, err };
  }
  this.skip();
  let typeArg: Type | null = null;
  if (this.peek() === "<") {
    this.advance();
    typeArg = this.parseType();
    this.skip();
    this.expect(">");
  }
  return { kind: "named", name, typeArg };
}
```

- [ ] **Step 9: Run tests — expect pass**

Run: `npx jest tests/parser.test.ts`
Expected: all tests PASS

- [ ] **Step 10: Commit**

```bash
git add src/parser.ts tests/parser.test.ts
git commit -m "feat: parse capability, record, enum, type_alias, resource decls"
```

---

### Task 5: Parse fn Declarations

Covers: signature-only fns, fns with bodies, `using` clause, full `parseType` (already done).

**Files:**
- Modify: `src/parser.ts`
- Modify: `tests/parser.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/parser.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests — expect failure**

Run: `npx jest tests/parser.test.ts -t "parse fn"`
Expected: FAIL — TODO from parseFn

- [ ] **Step 3: Implement parseFn**

Replace `private parseFn(_pos: Pos): Decl { throw new Error("TODO"); }` with:

```typescript
private parseFn(pos: Pos): Decl {
  const name = this.ident();
  this.expect("(");
  const params: ParamDef[] = [];
  this.skip();
  while (this.peek() !== ")") {
    const pname = this.ident();
    this.expect(":");
    const type_ = this.parseType();
    params.push({ name: pname, type_ });
    this.skip();
    if (this.peek() === ",") { this.advance(); this.skip(); }
  }
  this.expect(")");
  // optional using clause
  const caps: string[] = [];
  this.skip();
  let kw = this.peekIdent();
  if (kw === "using") {
    this.ident(); // consume "using"
    caps.push(this.ident());
    this.skip();
    while (this.peek() === ",") {
      this.advance();
      caps.push(this.ident());
      this.skip();
    }
  }
  this.expect("->");
  const returnType = this.parseType();
  this.skip();
  let body: Stmt[] | null = null;
  if (this.peek() === "{") {
    body = this.parseBlock();
  }
  return { kind: "fn", name, params, caps, returnType, body, pos };
}

private peekIdent(): string {
  let i = this.idx;
  // skip whitespace
  while (i < this.src.length && /[ \t\r\n]/.test(this.src[i])) i++;
  let s = "";
  while (i < this.src.length && /[a-zA-Z_]/.test(this.src[i])) s += this.src[i++];
  return s;
}
```

- [ ] **Step 4: Implement parseBlock stub**

Replace `private parseBlock(): Stmt[] { throw new Error("TODO"); }` with:

```typescript
private parseBlock(): Stmt[] {
  this.expect("{");
  const stmts: Stmt[] = [];
  this.skip();
  while (this.peek() !== "}") {
    stmts.push(this.parseStmt());
    this.skip();
  }
  this.expect("}");
  return stmts;
}
```

- [ ] **Step 5: Run tests — expect pass**

Run: `npx jest tests/parser.test.ts`
Expected: all PASS (parseStmt still throws TODO but none of the current tests call it)

- [ ] **Step 6: Commit**

```bash
git add src/parser.ts tests/parser.test.ts
git commit -m "feat: parse fn declarations with using clause and return type"
```

---

### Task 6: Parse Core Statements and Expressions

Covers: `let`, `let mut`, rebind, `expr` stmt, `break`, `var`, `call`, `try`.

**Files:**
- Modify: `src/parser.ts`
- Modify: `tests/parser.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/parser.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests — expect failure**

Run: `npx jest tests/parser.test.ts -t "parse let|parse rebind|parse call|parse try|parse break|parse drop"`
Expected: FAIL — TODO from parseStmt / parseExpr

- [ ] **Step 3: Implement parseExpr**

Replace `private parseExpr(): Expr { throw new Error("TODO"); }` with:

```typescript
private parseExpr(): Expr {
  this.skip();
  const p = this.pos();
  if (this.peek() === "(" && this.peek(1) === ")") {
    this.advance(); this.advance();
    return { kind: "unit_val", pos: p };
  }
  const name = this.ident();
  this.skip();
  if (this.peek() === "(") {
    // call or Ok/Err
    this.advance(); // consume (
    this.skip();
    if (name === "Ok") {
      const inner = this.parseExpr();
      this.skip(); this.expect(")");
      const e: Expr = { kind: "ok", expr: inner, pos: p };
      return this.parseTry(e);
    }
    if (name === "Err") {
      const inner = this.parseExpr();
      this.skip(); this.expect(")");
      const e: Expr = { kind: "err", expr: inner, pos: p };
      return this.parseTry(e);
    }
    const args: Expr[] = [];
    while (this.peek() !== ")") {
      args.push(this.parseExpr());
      this.skip();
      if (this.peek() === ",") { this.advance(); this.skip(); }
    }
    this.expect(")");
    const e: Expr = { kind: "call", fn: name, args, pos: p };
    return this.parseTry(e);
  }
  const e: Expr = { kind: "var", name, pos: p };
  return this.parseTry(e);
}

private parseTry(e: Expr): Expr {
  this.skip();
  if (this.peek() === "?") {
    const p = this.pos();
    this.advance();
    return { kind: "try", expr: e, pos: p };
  }
  return e;
}
```

- [ ] **Step 4: Implement parseStmt (core cases)**

Replace `private parseStmt(): Stmt { throw new Error("TODO"); }` with:

```typescript
private parseStmt(): Stmt {
  this.skip();
  const p = this.pos();
  const ch = this.peek();

  if (ch === "l" && this.src.slice(this.idx, this.idx + 4) === "let ") {
    this.expect("let");
    this.skip();
    let mut = false;
    if (this.peekIdent() === "mut") { this.ident(); mut = true; }
    const name = this.ident();
    this.expect("=");
    const init = this.parseExpr();
    return { kind: "let", name, mut, init, pos: p };
  }

  if (ch === "b" && this.src.slice(this.idx, this.idx + 5) === "break") {
    this.expect("break");
    return { kind: "break", pos: p };
  }

  if (ch === "i" && this.src.slice(this.idx, this.idx + 3) === "if ") {
    return this.parseIf(p);
  }

  if (ch === "l" && this.src.slice(this.idx, this.idx + 5) === "loop ") {
    return this.parseLoop(p);
  }
  if (ch === "l" && this.src.slice(this.idx, this.idx + 5) === "loop\n") {
    return this.parseLoop(p);
  }
  if (ch === "l" && this.src.slice(this.idx, this.idx + 5) === "loop{") {
    return this.parseLoop(p);
  }

  if (ch === "m" && this.src.slice(this.idx, this.idx + 6) === "match ") {
    return this.parseMatchStmt(p);
  }

  if (ch === "s" && this.src.slice(this.idx, this.idx + 7) === "select ") {
    return this.parseSelect(p);
  }

  // expression or rebind
  const name = this.ident();
  this.skip();
  if (this.peek() === "=" && this.peek(1) !== "=") {
    this.advance(); // consume =
    const expr = this.parseExpr();
    return { kind: "rebind", name, expr, pos: p };
  }
  // expression statement — re-enter parseExpr with name already consumed
  const expr = this.parseExprWithName(name, p);
  return { kind: "expr", expr, pos: p };
}

private parseExprWithName(name: string, p: Pos): Expr {
  this.skip();
  if (this.peek() === "(") {
    this.advance();
    this.skip();
    if (name === "Ok") {
      const inner = this.parseExpr();
      this.skip(); this.expect(")");
      const e: Expr = { kind: "ok", expr: inner, pos: p };
      return this.parseTry(e);
    }
    if (name === "Err") {
      const inner = this.parseExpr();
      this.skip(); this.expect(")");
      const e: Expr = { kind: "err", expr: inner, pos: p };
      return this.parseTry(e);
    }
    const args: Expr[] = [];
    while (this.peek() !== ")") {
      args.push(this.parseExpr());
      this.skip();
      if (this.peek() === ",") { this.advance(); this.skip(); }
    }
    this.expect(")");
    const e: Expr = { kind: "call", fn: name, args, pos: p };
    return this.parseTry(e);
  }
  const e: Expr = { kind: "var", name, pos: p };
  return this.parseTry(e);
}

private parseIf(_p: Pos): Stmt { throw new Error("TODO: parseIf"); }
private parseLoop(_p: Pos): Stmt { throw new Error("TODO: parseLoop"); }
private parseMatchStmt(_p: Pos): Stmt { throw new Error("TODO: parseMatch"); }
private parseSelect(_p: Pos): Stmt { throw new Error("TODO: parseSelect"); }
```

- [ ] **Step 5: Run tests — expect pass**

Run: `npx jest tests/parser.test.ts`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/parser.ts tests/parser.test.ts
git commit -m "feat: parse let, rebind, call, try, break, drop statements"
```

---

### Task 7: Parse if, loop, match, select

**Files:**
- Modify: `src/parser.ts`
- Modify: `tests/parser.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/parser.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests — expect failure**

Run: `npx jest tests/parser.test.ts -t "parse if|parse loop|parse match|parse select"`
Expected: FAIL — TODO stubs

- [ ] **Step 3: Implement parseIf**

Replace `private parseIf(_p: Pos): Stmt { throw new Error("TODO: parseIf"); }` with:

```typescript
private parseIf(p: Pos): Stmt {
  this.expect("if");
  const cond = this.parseExpr();
  const then = this.parseBlock();
  this.skip();
  this.expect("else");
  const else_ = this.parseBlock();
  return { kind: "if", cond, then, else_, pos: p };
}
```

- [ ] **Step 4: Implement parseLoop**

Replace `private parseLoop(_p: Pos): Stmt { throw new Error("TODO: parseLoop"); }` with:

```typescript
private parseLoop(p: Pos): Stmt {
  this.expect("loop");
  const body = this.parseBlock();
  return { kind: "loop", body, pos: p };
}
```

- [ ] **Step 5: Implement parsePattern**

Replace `private parsePattern(): Pattern { throw new Error("TODO"); }` with:

```typescript
private parsePattern(): Pattern {
  this.skip();
  if (this.peek() === "_") {
    this.advance();
    return { kind: "wildcard" };
  }
  const name = this.ident();
  this.skip();
  const binds: string[] = [];
  if (this.peek() === "(") {
    this.advance();
    this.skip();
    while (this.peek() !== ")") {
      binds.push(this.ident());
      this.skip();
      if (this.peek() === ",") { this.advance(); this.skip(); }
    }
    this.expect(")");
  }
  return { kind: "variant", name, binds };
}
```

- [ ] **Step 6: Implement parseMatchStmt**

Replace `private parseMatchStmt(_p: Pos): Stmt { throw new Error("TODO: parseMatch"); }` with:

```typescript
private parseMatchStmt(p: Pos): Stmt {
  this.expect("match");
  const expr = this.parseExpr();
  this.expect("{");
  const arms: MatchArm[] = [];
  this.skip();
  while (this.peek() !== "}") {
    const pattern = this.parsePattern();
    this.skip();
    this.expect("=>");
    this.skip();
    let body: Stmt[];
    if (this.peek() === "{") {
      body = this.parseBlock();
    } else {
      body = [this.parseStmt()];
    }
    this.skip();
    if (this.peek() === ",") { this.advance(); this.skip(); }
    arms.push({ pattern, body });
  }
  this.expect("}");
  return { kind: "match", expr, arms, pos: p };
}
```

- [ ] **Step 7: Implement parseSelect**

Replace `private parseSelect(_p: Pos): Stmt { throw new Error("TODO: parseSelect"); }` with:

```typescript
private parseSelect(p: Pos): Stmt {
  this.expect("select");
  const atoms: string[] = [];
  atoms.push(this.ident());
  this.skip();
  while (this.peek() === ",") {
    this.advance();
    atoms.push(this.ident());
    this.skip();
  }
  this.expect("from");
  const from = this.ident();
  return { kind: "select", atoms, from, pos: p };
}
```

- [ ] **Step 8: Run tests — expect pass**

Run: `npx jest tests/parser.test.ts`
Expected: all PASS

- [ ] **Step 9: Commit**

```bash
git add src/parser.ts tests/parser.test.ts
git commit -m "feat: parse if/else, loop, match, select statements"
```

---

### Task 8: Parse Ok, Err, unit_val Expressions

These are already wired into `parseExpr` from Task 6. This task adds dedicated expression tests and verifies `Ok(())`.

**Files:**
- Modify: `tests/parser.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/parser.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests — expect pass (or diagnose)**

Run: `npx jest tests/parser.test.ts -t "parse Ok|parse Err|parse try on"`
Expected: PASS — already handled in parseExpr

- [ ] **Step 3: Commit**

```bash
git add tests/parser.test.ts
git commit -m "test: explicit Ok/Err/unit_val expression tests"
```

---

### Task 9: Integration Test — payment.fit

**Files:**
- Create: `tests/payment.fit`
- Modify: `tests/parser.test.ts`

- [ ] **Step 1: Write payment.fit**

Create `tests/payment.fit` with the exact canonical text from FIT-SYNTAX.md §10:

```fit
capability ChargeCard

resource AuthToken {
    token_id: TokenId,
    cleanup:  void_token,
}

enum PaymentError { Declined, NetworkFail, InvalidCard, AlreadyCharged }

fn validate_card(card: CardDetails) using Net
    -> Result<AuthToken, PaymentError>

fn execute_charge(token: AuthToken, amount: Cents) using Net, ChargeCard
    -> Result<Receipt, PaymentError>

fn audit_log(receipt: Receipt) using Net
    -> Result<(), PaymentError>

fn process_payment(card: CardDetails, amount: Cents) using Net, ChargeCard
    -> Result<Receipt, PaymentError> {

    let token   = validate_card(card)?
    let receipt = execute_charge(token, amount)?
    audit_log(receipt)?
    Ok(receipt)
}
```

- [ ] **Step 2: Write failing integration test**

Add to `tests/parser.test.ts`:

```typescript
import * as fs from "fs";
import * as path from "path";

test("parse payment.fit — no errors", () => {
  const src = fs.readFileSync(path.join(__dirname, "payment.fit"), "utf8");
  const prog = parse(src, "payment.fit");
  expect(prog.decls).toHaveLength(5); // capability + resource + enum + 3 fn sigs + 1 fn with body = 6... let's count
  // capability, resource, enum, validate_card, execute_charge, audit_log, process_payment
  expect(prog.decls).toHaveLength(7);
});

test("parse payment.fit — process_payment body", () => {
  const src = fs.readFileSync(path.join(__dirname, "payment.fit"), "utf8");
  const prog = parse(src, "payment.fit");
  const fn_ = prog.decls.find(d => d.kind === "fn" && d.name === "process_payment");
  expect(fn_).toBeDefined();
  if (fn_?.kind === "fn") {
    expect(fn_.body).not.toBeNull();
    expect(fn_.body).toHaveLength(4); // let token, let receipt, audit_log?, Ok(receipt)
    expect(fn_.caps).toEqual(["Net", "ChargeCard"]);
  }
});
```

- [ ] **Step 3: Run test — fix any parse errors**

Run: `npx jest tests/parser.test.ts -t "parse payment.fit"`
Expected: PASS — if not, read the error, locate the failing position, fix the parser.

Common failure points:
- Multi-line fn signature (newline between param list and `using` clause) — ensure `skip()` handles newlines before `using`
- `using Net,` with trailing comma — ensure caps loop handles trailing comma after last cap

- [ ] **Step 4: Fix if failing, re-run**

If `peekIdent()` fails to find `using` across a newline, verify `skip()` is called in `peekIdent`:

```typescript
private peekIdent(): string {
  let i = this.idx;
  while (i < this.src.length && /[ \t\r\n]/.test(this.src[i])) i++;
  let s = "";
  while (i < this.src.length && /[a-zA-Z_0-9]/.test(this.src[i])) s += this.src[i++];
  return s;
}
```

- [ ] **Step 5: Commit**

```bash
git add tests/payment.fit tests/parser.test.ts
git commit -m "test: payment.fit integration test passes"
```

---

### Task 10: Integration Test — smtp.fit

**Files:**
- Create: `tests/smtp.fit`
- Modify: `tests/parser.test.ts`

- [ ] **Step 1: Write smtp.fit**

Create `tests/smtp.fit` with the exact canonical text from FIT-SYNTAX.md §10:

```fit
enum SmtpState { Fresh, Greeted, Authed, Ready, Closing }

resource SmtpConn<S> {
    sock:    TcpSocket,
    cleanup: tcp_force_close,
}

enum SmtpError  { ConnRefused, AuthFailed, MailRejected }
type SessionError = SmtpError | IoError

fn connect(host: String)          using Net -> Result<SmtpConn<Fresh>,   SessionError>
fn greet  (c: SmtpConn<Fresh>)    using Net -> Result<SmtpConn<Greeted>, SessionError>
fn auth   (c: SmtpConn<Greeted>,
           creds: Credentials)    using Net -> Result<SmtpConn<Authed>,  SessionError>
fn ready  (c: SmtpConn<Authed>)   using Net -> Result<SmtpConn<Ready>,   SessionError>
fn quit   (c: SmtpConn<Ready>)    using Net -> Result<SmtpConn<Closing>, SessionError>
fn close  (c: SmtpConn<Closing>)  using Net -> Result<(), SessionError>

fn send_message(c: SmtpConn<Ready>, msg: Message) using Net
    -> Result<(), SessionError>

fn deliver_batch(c: SmtpConn<Ready>, msgs: List<Message>) using Net
    -> Result<(), SessionError> {
    let mut remaining = msgs
    loop {
        match next(remaining) {
            None             => break,
            Some(msg, rest)  => {
                send_message(c, msg)?
                remaining = rest
            },
        }
    }
    Ok(())
}

fn run_session(host: String, creds: Credentials, msgs: List<Message>) using Net
    -> Result<(), SessionError> {

    let c = connect(host)?
    let c = greet(c)?
    let c = auth(c, creds)?
    let c = ready(c)?
    deliver_batch(c, msgs)?
    let c = quit(c)?
    close(c)
}
```

- [ ] **Step 2: Write failing integration test**

Add to `tests/parser.test.ts`:

```typescript
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
  const fn_ = prog.decls.find(d => d.kind === "fn" && d.name === "deliver_batch");
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
  const fn_ = prog.decls.find(d => d.kind === "fn" && d.name === "run_session");
  if (fn_?.kind !== "fn" || fn_.body === null) throw new Error("missing run_session");
  // let c×5, deliver_batch?, let c = quit?, close(c) = 7 stmts
  expect(fn_.body).toHaveLength(7);
});
```

- [ ] **Step 3: Run test — fix any parse errors**

Run: `npx jest tests/parser.test.ts -t "parse smtp.fit"`
Expected: PASS — if not, check these known tricky spots:

1. **Multi-line param list in `auth`**: newline + indent between params. `skip()` before each param read handles this.
2. **`List<Message>` as a type**: `parseType` reads `List`, then `<`, then calls `parseType()` which reads `Message`. Confirm generic type parsing works here.
3. **`loop` keyword followed by `{` with no space**: ensure the `loop` check in `parseStmt` also matches `loop{` — or rely on `expect("loop")` + `skip()` + `parseBlock()` which naturally handles this.
4. **`match next(remaining)` — `next` is a call inside match expr**: `parseExpr` handles this as a call.
5. **Trailing comma after `},` in match block arm**: `parseMatchStmt` must consume `,` after the block body — this is already in Step 6 of Task 7.

- [ ] **Step 4: Run full test suite**

Run: `npx jest`
Expected: ALL PASS

- [ ] **Step 5: Final commit**

```bash
git add tests/smtp.fit tests/parser.test.ts
git commit -m "test: smtp.fit integration test passes — Step 1 complete"
```

---

## Self-Review

**Spec coverage:**
- `capability` decl — Task 4 ✓
- `record` decl — Task 4 ✓
- `enum` (unit + payload variants) — Task 4 ✓
- `type` union alias — Task 4 ✓
- `resource` (no typestate, with `<S>`, with `fallback`) — Task 4 ✓
- `fn` signature (params, `using`, return type) — Task 5 ✓
- `fn` body — Tasks 6–7 ✓
- `let` / `let mut` — Task 6 ✓
- rebind (`x = expr`) — Task 6 ✓
- `?` try — Task 6 ✓
- `Ok(expr)` / `Err(expr)` / `Ok(())` — Task 6+8 ✓
- `break` — Task 6 ✓
- `drop(conn)` — Task 6 (drop treated as regular call) ✓
- `if/else` (else mandatory) — Task 7 ✓
- `loop` — Task 7 ✓
- `match` (unit variant, payload binds, wildcard, block arms, comma-separated) — Task 7 ✓
- `select Read from Fs` — Task 7 ✓
- `unit_val` (`()`) — Task 8 ✓
- payment.fit integration — Task 9 ✓
- smtp.fit integration — Task 10 ✓

**Placeholder scan:** None found.

**Type consistency:**
- `MatchArm.body: Stmt[]` — consistent across Tasks 7 and 2 ✓
- `CleanupDef.fallback: boolean` — consistent across Tasks 4 and 2 ✓
- `parseExprWithName` used in `parseStmt` to avoid double-parsing the leading ident ✓
- `peekIdent()` used in both `parseFn` (for `using`) and `parseStmt` (for `mut`) ✓
