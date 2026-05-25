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
  | { kind: "break";  pos: Pos }
  | { kind: "select"; atoms: string[]; from: string; pos: Pos };
```

FIT has no explicit `return` keyword — the last expression in a block is the implicit
return value, and `?` handles early exits. No `return` statement node is needed.

**Implicit return convention.** The checker treats the final statement of a function body
as the return value as follows: if the last stmt has `kind: "expr"`, its expression is
the return value; any other final stmt (e.g. `let`, `rebind`, `match`) means the function
implicitly returns `()`. All canonical programs end with an `expr` stmt.

**`select` is a statement, not an expression.** `select Read from Fs` introduces the named
atom(s) into the local capability scope imperatively — it does not produce an assignable
value. The checker (Step 4) resolves capabilities by type, not by name; it finds the
projected atom by searching the local scope for a capability of the required type.
`select` appears in `Stmt` because it mutates scope; placing it in `Expr` would require
the checker to treat anonymous expression-statement results as live scope entries, which
is a special rule inconsistent with how every other expression statement works.

**Rebind consumes the previous value.** `x = expr` (`kind: "rebind"`) is not assignment
in the C sense. For a binding `x` holding a linear resource, the rebind:
1. Consumes the current value of `x` (cleanup fires, or the value is moved into `expr`)
2. Binds `x` to the new value

The old value is unavailable after the rebind. The checker must treat rebind the same as
a consuming call for linearity purposes.

### Expressions

```ts
type Expr =
  | { kind: "var";      name: string; pos: Pos }
  | { kind: "call";     fn: string; args: Expr[]; pos: Pos }
  | { kind: "try";      expr: Expr; pos: Pos }
  | { kind: "ok";       expr: Expr; pos: Pos }
  | { kind: "err";      expr: Expr; pos: Pos }
  | { kind: "unit_val"; pos: Pos };
```

`try` represents `expr?`. `unit_val` represents `()` — used in `Ok(())` and as the
implicit return of unit functions. `Ok` and `Err` are special AST nodes (not regular
`call` nodes) because the checker needs to identify them for `?`-operator branching
without string-matching function names.

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

## Checker-facing semantics encoded in the AST

These are parser-step observations that the checker (Steps 3–4) must honour. They are
recorded here so the Step 3 design does not have to rediscover them.

### Let-shadowing is the typestate transition mechanism

FIT-SYNTAX.md §4 shows typestate transitions written as repeated `let` bindings, not
`let mut` rebinds:

```fit
let c = connect(host)?     // c : SmtpConn<Fresh>
let c = greet(c)?          // old c consumed; new c : SmtpConn<Greeted>
let c = auth(c, creds)?    // old c consumed; new c : SmtpConn<Authed>
```

Each line is a new `{ kind: "let", name: "c", mut: false, ... }` node — not a `rebind`.
The second binding *shadows* the first. The checker must treat the old binding as consumed
the moment the same name appears in the `init` expression of a new `let` with the same
name. After the shadowing `let`, only the new binding is in scope; the old typestate is
gone. This is the primary mechanism for straight-line typestate progressions and is not
a special AST form — it is ordinary `let` with shadowing semantics enforced by the
checker.

### Bodyless function lend/move: heuristic and known gap

FIT-SPEC-v2.md §4: "lend vs move is inferred from the function body and frozen in the
published signature." Signature-only functions (`body: null`) have no body to inspect.

**Heuristic for the checker:** if the param's base type name appears anywhere in the
return type → move; otherwise → lend.

| Function | Return type | Verdict |
|----------|-------------|---------|
| `send_message(c: SmtpConn<Ready>) -> Result<(), ...>` | no SmtpConn | lend ✓ |
| `handshake(conn: Conn<Fresh>) -> Result<Conn<Ready>, ...>` | Conn present | move ✓ |
| `close(c: SmtpConn<Closing>) -> Result<(), ...>` | no SmtpConn | **lend ✗** |

**Known gap — `close`.** `close` consumes its argument (the body passes it to an
underlying consuming teardown call), but the heuristic classifies it as lend because
SmtpConn is absent from the return type. Consequence: the checker believes `c` is still
owned after `close(c)` in `run_session`, and records cleanup firing at scope exit — a
false double-close event. This does not cause the canonical program to be *rejected*
(no error is raised; cleanup firing is not an error), so the acceptance criterion still
passes.

This is a known limitation of body-free inference. The FIT spec does not define a
signature-only equivalent of the body inference rule. If this gap produces false
rejections in Step 5 test cases, escalate rather than patching with an ad-hoc rule.

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
  private parseStmt(): Stmt    // dispatches on: let, if, loop, match, break, select, expr
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
| `select` (stmt) | | |
| `using` caps | ✓ | ✓ |

`select` does not appear in the canonical programs but is in the syntax spec (§6) and the
payment.fit checker assertions, so it must parse. It is a `Stmt`, not an `Expr`.

---

## Out of scope for this step

- Type-checking, lend/move inference, linearity enforcement (Steps 2–4)
- `tsconfig.json`, `package.json`, project scaffolding (set up alongside this step)
- Test programs in `tests/` (Step 5)
