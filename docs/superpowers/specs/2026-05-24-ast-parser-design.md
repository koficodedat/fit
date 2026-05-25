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
  | { kind: "if";     cond: Expr; then: Stmt[]; else_: Stmt[]; pos: Pos }  // else mandatory
  | { kind: "loop";   body: Stmt[]; pos: Pos }
  | { kind: "match";  expr: Expr; arms: MatchArm[]; pos: Pos }
  | { kind: "break";  pos: Pos }
  | { kind: "select"; atoms: string[]; from: string; pos: Pos };
```

FIT has no explicit `return` keyword — the last expression in a block is the implicit
return value, and `?` handles early exits. No `return` statement node is needed.

**`if/else` — `else` is syntactically required, not only semantically.** FIT-SYNTAX.md
§5.1 shows `else` as part of the `if` form, not as an optional extension. With
`else_: Stmt[]` (non-nullable), the parser throws if `else` is absent — it is a parse
error, not a type error. A bare `if cond { ... }` without `else` is illegal in any FIT
program regardless of whether linear values are in scope. Test programs must always
include both branches.

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

**`from` is a contextual keyword, not a reserved word.** FIT-SPEC-v2.md §9 does not
list `from` in the reserved keywords. The parser must handle it literally: after reading
the atom list in a `select` statement, `parseStmt` matches the character sequence `from`
explicitly (e.g. `this.expect("from")`). It must not rely on a general reserved-word
check, and it must not prevent a programmer from naming a variable `from` in other
contexts.

**`drop` is reserved but legal in call position.** `drop` appears in the reserved
keywords list (FIT-SPEC-v2.md §9) yet FIT-SYNTAX.md §8 shows `drop(conn)` as a plain
function call. The parser resolves this by allowing `drop` as a function name: when
`parseExpr` reads the identifier `drop` followed by `(`, it produces
`{ kind: "call", fn: "drop", args: [...] }` normally. `drop` is reserved to prevent
user-defined types or functions from shadowing the built-in, not to make it
unparseable.

**Rebind consumes the previous value.** `x = expr` (`kind: "rebind"`) is not assignment
in the C sense. For a binding `x` holding a linear resource, the rebind:
1. Consumes the current value of `x` (cleanup fires, or the value is moved into `expr`)
2. Binds `x` to the new value

The old value is unavailable after the rebind. The checker must treat rebind the same as
a consuming call for linearity purposes.

**No semicolons — newlines are statement separators.** FIT has no `;` statement
terminator. `parseBlock` calls `skip()` (whitespace + comments) between statements, not
a punctuation consumer. The block ends when `skip()` leaves the cursor at `}` or EOF.
Any implementation that expects `;` between statements will fail immediately on both
canonical programs.

**Statement/expression disambiguation — peek after identifier.** `parseStmt` dispatches
on the first token. When the first token is a bare identifier (not a keyword), the parser
reads it and then peeks at the next non-whitespace character:
- `=` and the character after it is not `=` → rebind: emit `{ kind: "rebind" }`, consume
  `=`, parse RHS expression.
- Anything else → expression statement: use the already-read identifier as the start of
  an expression (a function call or a variable reference), parse the full expression, emit
  `{ kind: "expr" }`.

This single-token lookahead is the only disambiguation needed. The canonical programs
exercise both paths: `remaining = rest` (rebind) and `send_message(c, msg)?` (expression).

**Match arm body is dual-mode: single statement or block.** `parseMatch` reads arms
separated by commas (see below). For each arm, after consuming `=>`, the parser checks
the next non-whitespace character:
- `{` → call `parseBlock()` to read a multi-statement body
- Anything else → call `parseStmt()` and wrap the result in a single-element `Stmt[]`

Both produce the same `MatchArm.body: Stmt[]` type. The canonical smtp.fit exercises
both: `None => break,` (single stmt) and `Some(msg, rest) => { ... },` (block).

**Match arms are comma-separated; comma required even after block arms.** Every arm in
the canonical smtp.fit ends with `,` — including the block arm. Trailing comma before
`}` is allowed (consistent with record field syntax). The parser must consume `,` after
every arm body, including block bodies, and stop when it sees `}` after the optional
trailing comma.

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

**`Ok` and `Err` in pattern position.** The `Expr` union has special `ok` and `err`
nodes for constructing `Result` values. In *pattern* position, `Ok(v)` and `Err(e)` flow
through `Pattern.variant` — `{ kind: "variant", name: "Ok", binds: ["v"] }` — not
through any special result node. The parser disambiguates by context: `parseExpr` sees
`Ok(` and emits `{ kind: "ok" }`; `parsePattern` sees `Ok(` and emits
`{ kind: "variant", name: "Ok" }`. The two parse paths are distinct and must not share
logic. The canonical programs do not match on `Result` directly (they use `?`), but test
programs in `should_pass`/`should_fail` may.

---

## Undeclared symbol policy

Both canonical programs reference types and functions that are never declared in the
source file:

| Symbol | Used in | Type |
|--------|---------|------|
| `next` | smtp.fit `deliver_batch` | function |
| `List<Message>`, `Message` | smtp.fit | types |
| `Credentials`, `String` | smtp.fit | types |
| `TcpSocket`, `IoError` | smtp.fit | types |
| `CardDetails`, `Cents`, `Receipt`, `TokenId` | payment.fit | types |

The parser accepts all of these as plain identifiers — no parser-level error. The checker
needs an explicit policy or it will crash on the canonical programs:

1. **Undeclared types are unrestricted plain data by default.** The checker treats any
   type name with no `record`, `enum`, or `resource` declaration as an unrestricted
   (non-linear) value. This is consistent with FIT-SPEC-v2.md §2.1: "Default is
   unrestricted." It means the checker cannot verify linearity properties *about* those
   types, but it will not raise false errors on programs that use them.

2. **Undeclared functions are trusted.** The checker uses the declared signature (params
   and return type) as-is and applies the lend/move heuristic for bodyless functions.
   It does not error on "function not defined."

3. **Match exhaustiveness is skipped for undeclared scrutinee types.** When the
   scrutinee of a `match` has an undeclared type (e.g. the return of `next`), the
   checker cannot enumerate expected variants. It accepts the match without exhaustiveness
   verification. This is the only instance where the checker silently skips a rule —
   it should be logged as a limitation in checker output if possible.

This policy allows the canonical programs to pass without requiring every referenced
type to be in-file. If a test program in Step 5 requires exhaustiveness checking on an
undeclared type, add a minimal declaration to that test file rather than changing the
policy.

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

### Lent parameters are not owned by the callee — cleanup does not fire for them

FIT-SPEC-v2.md §3: cleanup fires "on every scope exit where the value is **still owned**."
§4: "lend = use without consuming... borrows it **for the duration of the call only**."

A lent parameter is borrowed, not owned, by the callee. Cleanup is the caller's
responsibility. The checker must track, for each binding in scope, whether it is **owned**
(cleanup fires here on `?`-exit) or **lent** (no cleanup responsibility; caller retains
ownership).

Concrete consequence in `deliver_batch`:

```
send_message(c, msg)?   // c is lent from run_session; deliver_batch does not own it
```

If `send_message` fails, `?` fires cleanup for values `deliver_batch` owns. `c` is not
one of them — `deliver_batch` only borrows it. `remaining` is unrestricted. So nothing
needs cleanup at this exit point. The error propagates to `run_session`, where `c` is
still owned, and `run_session`'s `?` fires cleanup on `c` there.

A checker that fires cleanup on all linear values in scope at every `?` — regardless of
owned vs lent — will produce a false double-free path through `deliver_batch`.

### `let` init is evaluated before the new binding enters scope

`let c = greet(c)?` — the `c` inside `greet(c)` must resolve to the **old** binding,
not the new one being introduced. The correct evaluation order:

1. Evaluate `init` expression in the current scope (old `c` is in scope, its type is
   `SmtpConn<Fresh>`)
2. Consume any values moved by `init` (old `c` is consumed by passing to `greet`)
3. Introduce the new binding `c` into scope with the type produced by `init`
   (`SmtpConn<Greeted>` after the `?` unwrap)

A checker that introduces the new binding before step 1 will either fail to find the old
`c` (shadowed too early) or resolve the wrong type. This rule applies to all `let`
statements, not only shadowing ones.

### Records with resource-typed fields are transitively linear

FIT-SYNTAX.md §2.1: "All fields are plain data unless their type is a resource, in which
case the record is itself linear — it owns a resource."

The `record` AST node has no `cleanup` field. The checker derives linearity by inspecting
each `FieldDef.type_`: if any field's base type name resolves to a `resource` declaration,
the record is linear. Its effective cleanup is "fire cleanup for each resource-typed field
in declaration order" — constructed by the checker, not written anywhere.

For the PoC canonical programs this does not arise (no declared record has a resource
field — all resource-typed field names are undeclared and treated as unrestricted). But
the rule must be in the checker to handle test programs that exercise it.

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
  private parseStmt(): Stmt      // dispatches on: let, if, loop, match, break, select, expr
  private parseExpr(): Expr
  private parsePattern(): Pattern // distinct from parseExpr; Ok(x) → variant, not ok-expr
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
