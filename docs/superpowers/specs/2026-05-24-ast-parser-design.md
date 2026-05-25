# Step 1 Design — AST + Parser

**Date:** 2026-05-24
**Scope:** FIT PoC Step 1 (CLAUDE.md build order)
**Status:** Approved

---

## What this covers

The AST type definitions (`src/ast.ts`) and the hand-written recursive-descent parser
(`src/parser.ts`) that produces them. No type-checking logic is in scope here — that is
Steps 2–4.

---

## Approach

Character-by-character recursive descent. The `Parser` class holds the source string and
an index cursor; it advances one character at a time while tracking `line` and `col`.
No separate tokenization pass. Panicking on malformed input is acceptable for the PoC.

---

## File layout

```
src/
  ast.ts      — all type definitions; no logic
  parser.ts   — Parser class + parse() entry point
```

---

## Shared base type

Every AST node carries a source position for located error messages.

```ts
type Pos = { line: number; col: number };
```

Error format produced by the parser (and later the checker):

```
filename:line:col: message
```

---

## AST node types (`ast.ts`)

### Program

```ts
type Program = { decls: Decl[] };
```

### Declarations

```ts
type Decl =
  | { kind: "capability"; name: string; pos: Pos }
  | { kind: "record";     name: string; fields: FieldDef[]; pos: Pos }
  | { kind: "enum";       name: string; variants: VariantDef[]; pos: Pos }
  | { kind: "resource";   name: string; typeParam: string | null; fields: FieldDef[]; cleanup: CleanupDef; pos: Pos }
  | { kind: "type_alias"; name: string; members: string[]; pos: Pos }
  | { kind: "fn";         name: string; params: ParamDef[]; caps: string[]; returnType: Type; body: Stmt[] | null; pos: Pos };
```

`fn` body is `null` for signature-only declarations (e.g. `connect`, `greet` in smtp.fit).

### Types

```ts
type Type =
  | { kind: "named";  name: string; typeArg: Type | null }
  | { kind: "result"; ok: Type; err: Type }
  | { kind: "unit" };
```

### Statements

```ts
type Stmt =
  | { kind: "let";    name: string; mut: boolean; init: Expr; pos: Pos }
  | { kind: "rebind"; name: string; expr: Expr; pos: Pos }
  | { kind: "expr";   expr: Expr; pos: Pos }
  | { kind: "if";     cond: Expr; then: Stmt[]; else_: Stmt[]; pos: Pos }
  | { kind: "loop";   body: Stmt[]; pos: Pos }
  | { kind: "match";  expr: Expr; arms: MatchArm[]; pos: Pos }
  | { kind: "break";  pos: Pos };
```

FIT has no explicit `return` keyword — the last expression in a block is the implicit
return value, and `?` handles early exits. No `return` statement node is needed.

### Expressions

```ts
type Expr =
  | { kind: "var";      name: string; pos: Pos }
  | { kind: "call";     fn: string; args: Expr[]; pos: Pos }
  | { kind: "try";      expr: Expr; pos: Pos }
  | { kind: "ok";       expr: Expr; pos: Pos }
  | { kind: "err";      expr: Expr; pos: Pos }
  | { kind: "select";   atoms: string[]; from: string; pos: Pos }
  | { kind: "unit_val"; pos: Pos };
```

`try` represents `expr?`. `select` represents `select Read, Write from Fs`.
`unit_val` represents `()` — used in `Ok(())` and as the implicit return of unit functions.

### Supporting types

```ts
type FieldDef   = { name: string; type_: Type };
type ParamDef   = { name: string; type_: Type };
type CleanupDef = { fallback: boolean; fn: string };
type VariantDef = { name: string; payload: Type | null };
type MatchArm   = { pattern: Pattern; body: Stmt[] };
type Pattern    =
  | { kind: "variant";  name: string; binds: string[] }
  | { kind: "wildcard" };
```

`CleanupDef.fallback` captures the optional `fallback` keyword on resource cleanup.
`VariantDef.payload` is null for unit variants (e.g. `None`, `Closed`).
`Pattern.binds` covers zero binds (`None`), one bind (`Some(msg)`), and two binds
(`Some(msg, rest)` where the variant wraps a two-field record).

---

## Parser structure (`parser.ts`)

```ts
class Parser {
  private src: string;
  private idx = 0;
  private line = 1;
  private col = 1;
  private filename: string;

  private advance(): string        // consume one char, update line/col
  private peek(offset = 0): string // look ahead without consuming
  private skip(): void             // skip whitespace, // comments, /* */ comments
  private pos(): Pos               // snapshot current position
  private ident(): string          // consume [a-zA-Z_][a-zA-Z0-9_]*
  private expect(s: string): void  // consume exact string or throw

  parseProgram(): Program          // top-level loop; dispatches on keyword
  private parseDecl(): Decl
  private parseRecord(): Decl
  private parseEnum(): Decl
  private parseResource(): Decl
  private parseTypeAlias(): Decl
  private parseCapability(): Decl
  private parseFn(): Decl
  private parseType(): Type
  private parseBlock(): Stmt[]
  private parseStmt(): Stmt
  private parseExpr(): Expr
}

export function parse(src: string, filename: string): Program
```

`parseProgram` peeks at the next identifier to dispatch:
`record | enum | resource | type | capability | fn` — anything else throws.

---

## What the two canonical programs exercise

| Feature | payment.fit | smtp.fit |
|---------|-------------|----------|
| `capability` decl | ✓ | |
| `resource` (no typestate) | ✓ | |
| `resource<S>` | | ✓ |
| `enum` | ✓ | ✓ |
| `type` alias (`\|`) | | ✓ |
| fn signature only | ✓ | ✓ |
| fn with body | ✓ | ✓ |
| `let` / `let mut` | ✓ | ✓ |
| rebind (`x = expr`) | | ✓ |
| `?` propagation | ✓ | ✓ |
| `Ok(expr)` | ✓ | ✓ |
| `loop` + `break` | | ✓ |
| `match` with payload binds | | ✓ |
| `select` | | |
| `using` caps | ✓ | ✓ |

`select` does not appear in the canonical programs but is in the syntax spec (§6) and the
payment.fit checker assertions, so it must parse.

---

## Out of scope for this step

- Type-checking, lend/move inference, linearity enforcement (Steps 2–4)
- `tsconfig.json`, `package.json`, project scaffolding (set up alongside this step)
- Test programs in `tests/` (Step 5)
