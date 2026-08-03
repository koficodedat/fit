# FIT — Syntax Reference

**Version:** v0.1
**Status:** v0.1 surface syntax, regenerated from the implementation. Settled forms are firm; deferred items and open questions are explicit and separated.
**Supersedes:** the prior v0.1 reference (`9fb5cf4`).

**Why regenerated rather than patched:** the documentation audit (`6bc62c8`) found this document contradicting `FIT-SPEC-v2.md` on two constructs (record-field legality, match exhaustiveness) and missing an expression-grammar section entirely — the structural gap that let "does FIT have integer literals?" go undecided for two months. Patching would have preserved the hole; every claim below was re-derived from `src/parser.ts` (primary source), `src/checker.ts` and `src/types.ts` (rule enforcement), `src/loader.ts` (modules), and `src/codegen.ts` (representation notes), not from the document being replaced, the `.fit` corpus, or memory of prior rounds. Disagreements found between the parser and another document are reported at the point they matter, not silently reconciled — see the callouts marked **[divergence found]**.

**Scope note:** This is a checker/reader target, not a formal grammar specification, except §5 (Expression grammar), which is written as a grammar because its absence — as prose scattered across examples — is exactly what caused the two-month gap this round exists to close.

---

## 1. Notation conventions

### 1.1 Lexical

- Single-line comments: `// ...` to end of line.
- Block comments: `/* ... */`, must be closed (`unterminated block comment` is a parse error).
- Identifiers: ASCII letters and underscore first character, then letters/digits/underscore. Case has no grammatical meaning — PascalCase for types/capabilities and snake_case for values/functions are conventions this document follows, not rules the parser enforces.
- Integer literals: a decimal digit run (§5.2).
- No string, character, or floating-point literal syntax exists (§12.2).

### 1.2 Keywords — recognized by position, not reserved globally **[divergence found]**

The parser has no separate keyword-token stage: `ident()` accepts any letter/underscore-led run uniformly, and every word below is recognized only by an exact string comparison at one specific parse position — there is no blocklist preventing these words from being used as ordinary identifiers elsewhere. Verified directly against the parser: `fn data() -> Int`, `resource linear { cleanup: f }`, `fn g() -> () { let drop = 5 }`, and `fn true() -> Int` all parse successfully today. The prior document's "cannot appear as identifiers" framing does not hold for any word in this table; only the position listed is where the word drives parsing.

| Word(s) | Recognized at | Effect outside that position |
|---|---|---|
| `resource`, `capability`, `record`, `enum`, `type`, `fn`, `import` | Start of a top-level declaration | Ordinary identifier |
| `let`, `if`, `loop`, `match`, `break`, `select` | Start of a statement | Ordinary identifier |
| `mut` | Immediately after `let` | Ordinary identifier |
| `else` | Immediately after an `if` block | Ordinary identifier |
| `using` | After a function's parameter list | Ordinary identifier |
| `from` | Inside a `select` statement | Ordinary identifier |
| `move`, `lend` | Between a parameter's `:` and its type | Ordinary identifier (documented as "contextual" in the prior version — that framing is accurate for these two specifically) |
| `true`, `false` | Any expression (primary) position | Ordinary identifier *as a binding name* — `let true = 5` parses — but a variable literally named `true`/`false` is unreachable: every subsequent expression-position use of the word resolves to the literal, checked before variable lookup, never to the shadowed binding |
| `data`, `struct`, `sum`, `union`, `error`, `linear`, `affine` | Nowhere | Ordinary identifier everywhere, always. `FIT-SPEC-v2.md` §9 lists these as reserved-by-design-intent ("held... so a future programmer cannot claim a name we may need"); the parser does not currently enforce that reservation. This is a design commitment, not a current parser rule — not a spec/parser contradiction (the spec doesn't claim current enforcement), but worth stating precisely rather than repeating the prior blanket phrasing. |

Tooling note, carried forward: syntax highlighting must be position-aware, not word-list-based, to avoid false-positive keyword coloring — this is now doubly true, since the parser itself is position-aware and a word-list highlighter would color more than the language actually restricts.

---

## 2. Type declarations

### 2.1 Product types — `record`

```fit
record Point {
    x: Int,
    y: Int,
}
```

Fields are comma-separated (trailing comma allowed). A `record` never declares cleanup and is therefore never a resource.

**A record field may not be linear** (a resource, or an enum carrying a linear payload) — enforced in `buildTypeEnv`: `record 'R' has linear field 'f' of type 'T' — records declare no cleanup and cannot own linear values; use a resource or an enum variant`. **[divergence found]** — the prior document read as though a resource-typed field was legal so long as the record itself stayed non-linear ("never a resource *even if a field is itself a resource*"); it is rejected outright. This matches `FIT-SPEC-v2.md` §2.3 exactly, which already stated the rule the prior syntax document had not caught up to.

### 2.2 Sum types — `enum`

```fit
enum Direction { North, East, South, West }

enum ConnEvent {
    Data(Bytes),
    Error(String),
    Closed,
}
```

Variants are comma-separated. Payload is a single type in parentheses; multiple payload fields are wrapped in a record (`Variant(SomeRecord)`). No integer tags (`= 1`).

An enum is **linear** if any variant carries a linear payload, **unrestricted** otherwise — derived from the variants, not declared on the enum.

`DivByZero` (§5.4) is a built-in enum with this same shape (one unit variant, itself named `DivByZero`), registered before any user declaration is processed and reported as a duplicate — `'DivByZero' is a built-in type and cannot be redeclared` — if a program tries to declare it.

### 2.3 Named error union aliases

```fit
type SessionError = SmtpError | IoError
type HttpError    = ParseError | NetworkError | DbError
```

`|` is used only for named union aliases — syntactically distinct from `enum` (commas, no `|`). The `?` operator (§6.4) widens a member error type to its declared union; widening between unrelated types is a compile error.

**Flat membership only.** An alias of aliases is not transitively expanded — `type Outer = Inner | Z` where `Inner` is itself an alias does not make `Inner`'s members visible to widening against `Outer`. Nested-alias expansion is an unresolved design question (`checker.ts`, `errorTypeCompatible`'s reserved-but-unused `env` parameter).

### 2.4 Resources — `resource`

```fit
resource File {
    handle:  FileHandle,
    cleanup: force_close,
}

resource Conn<S> {
    sock:    TcpSocket,
    cleanup: tcp_force_close,
}
```

A `resource` is always linear. `cleanup` names the function that fires at scope exit if the value is still owned.

```fit
resource TxConn<S> {
    sock:     TcpSocket,
    cleanup:  fallback tcp_force_close,
}
```

The `fallback` keyword before the cleanup function name parses and is recorded (`CleanupDef.fallback`) but **has no runtime or checker effect** — nothing reads the flag to emit a warning. **[divergence found]** — the prior document claimed "the compiler warns if auto-cleanup fires" for a `fallback`-marked resource; grepped every occurrence of `fallback` across `src/`, and it is threaded through `ast.ts`/`types.ts` but never consulted in `checker.ts` or `codegen.ts`. This matches `FIT-SPEC-v2.md` §3's own honest framing ("Implementation deferred past PoC") — the syntax document had drifted from what the spec itself already disclosed.

`<S>` is the typestate parameter, required when the resource participates in typestate transitions — a compile-time-only phantom.

**Parameterized resource types in field positions** are accepted — `sock: TcpConn<Connected>` as a field type parses via the same `<...>` handling `parseType` uses everywhere a type appears. The inner type's typestate is recorded but not checked for cross-layer invariants (open question, §12.3).

### 2.5 Variant name resolution

Variant names need not be globally unique across enums. A bare `V` resolves unambiguously if exactly one declared enum contains it; if more than one does, the use site must qualify with dot syntax: `EnumName.V`.

```fit
enum IoError   { NotFound, PermissionDenied }
enum HttpError { NotFound, BadRequest }

fn handle(io: IoError, http: HttpError) -> () {
    match io {
        IoError.NotFound  => { /* ... */ },
        PermissionDenied  => { /* ... */ },
    }
}
```

**Resolution (from `resolveVariant`, `types.ts`):**
1. Bare `V`: exactly one match resolves; zero → `unknown variant 'V' in match pattern`; two or more → `ambiguous variant 'V' — declared by enums X, Y; use 'X.V' or 'Y.V' to disambiguate`.
2. Qualified `EnumName.V`: unknown enum → `unknown enum 'EnumName'`; enum found but no such variant → `enum 'EnumName' does not declare variant 'V'`; otherwise resolves.

Dot syntax only — no `::`. Within a single `match`, each arm resolves independently; bare and qualified arms may mix.

---

## 3. Function signatures

```fit
fn name(param: Type, param2: Type) -> ReturnType
fn name(param: Type) using Cap -> ReturnType
fn name(param: Type) using Cap1, Cap2 -> ReturnType
fn name(param: Type) using Cap -> Result<ReturnType, ErrorType>
fn name(param: Type) -> ()
```

`using` capabilities are comma-separated, appearing between the parameter list and the mandatory `->`.

### 3.1 Lend vs. move — the inference rule (no sigil)

For a bodied function, whether a parameter is lent or consumed is inferred from the body and frozen in the published signature (`inferParamModeFromBody`/`exprConsumesVar`, `types.ts`):

- **Move:** the body transfers the parameter onward on some path — returns it, wraps it in `Ok`/`Err`, passes it to another move-mode call, or passes it to `drop`.
- **Lend:** the body only uses it (passes to lends, reads it) and never transfers it onward.

```fit
fn read_data(conn: Conn<Ready>) -> Data                              // lend
fn handshake(conn: Conn<Fresh>) -> Result<Conn<Ready>, NetError>     // move
fn pool_add(pool: Pool, conn: Conn<Ready>) -> Pool                    // move on conn
```

Frozen once inferred — a later body edit that would flip lend↔move is a compile error at the signature.

### 3.2 Extern functions — explicit annotation required

Bodyless functions cannot be inferred. An extern with a linear parameter and no `move`/`lend` annotation is a compile error: `extern 'fn' has linear parameter 'x' with no move/lend annotation`.

```fit
fn close(c: move SmtpConn<Closing>) -> Result<(), SessionError>
fn send_message(c: lend SmtpConn<Ready>, msg: Message) -> Result<(), SessionError>
```

Non-linear parameters never require annotation; an annotation on one is accepted but contributes no information (always treated as lend). A bodied function may also carry an explicit annotation, which overrides inference.

---

## 4. Bindings and mutation

```fit
let x = expr
let mut x = expr
x = expr           // rebind — only valid if x was declared mut
```

`mut` is orthogonal to memory mode — a `let mut conn` holding a linear resource is still linear; `mut` only permits the *name* to be rebound. Each rebind consumes the previous value.

### 4.1 Let-shadowing

A `let x = ...` in an inner scope shadows an outer `x` for that scope's duration. If the inner initializer references the outer name (`let c = greet(c)?`), the outer value is consumed there; if not, the outer binding remains live and the shadow is purely lexical.

```fit
let c = connect(host)?      // c: Conn<Fresh>
let c = greet(c)?           // old c consumed; new c: Conn<Greeted>
let c = auth(c, creds)?     // old c consumed; new c: Conn<Authed>
```

### 4.2 Scope-exit enforcement

A linear value owned at any scope exit — function return, branch end, match-arm end, loop-body end — is a compile error if not consumed: `linear value 'x' must be consumed before leaving scope` (or the function-exit / branch / match-arm variants of the same message). Satisfied by a transferring call, `drop(x)` (§9), or returning the value.

---

## 5. Expression grammar

**This section did not exist in the prior document.** Its absence — nothing anywhere stated what could appear in an expression position — is why "does FIT have integer literals" went unanswered for two months; there was no place a missing answer would have been visibly missing from. Derived from `src/parser.ts`'s `parseExpr`, `parseBinLevel`, `parsePrimary`, `parseExprFromName`, and `parseTry`.

### 5.1 Grammar

```
expr           ::= equality
equality       ::= comparison ( ("==" | "!=") comparison )*
comparison     ::= additive ( ("<" | ">" | "<=" | ">=") additive )*
additive       ::= multiplicative ( ("+" | "-") multiplicative )*
multiplicative ::= primary ( ("*" | "/" | "%") primary )*

primary        ::= "(" ")"                                    ; unit value
                  | "(" expr ")" "?"?                          ; grouping
                  | INT_LITERAL "?"?
                  | "true" "?"?  |  "false" "?"?
                  | IDENT "." IDENT "?"?                       ; qualified variant reference
                  | "Ok" "(" expr ")" "?"?
                  | "Err" "(" expr ")" "?"?
                  | IDENT "(" ( expr ( "," expr )* )? ")" "?"?  ; call
                  | IDENT "?"?                                 ; variable
```

Every rule level is left-associative — a chain of same-level operators folds left (`a - b - c` is `(a - b) - c`), never right.

The grammar admits `?` after every primary, including a literal — `parseTry` runs once per primary production regardless of what it just parsed, so `5?` and `true?` parse. Both are meaningless in practice: the checker's `"try"` case requires the inner expression to type as `Result<_, _>`, and no literal ever does, so both are rejected — `'?' applied to non-Result type`. The grammar's permissiveness here is a byproduct of where `parseTry` sits, not a claim that `?` on a literal means anything.

### 5.2 Precedence (tightest first)

| Level | Operators | Associativity |
|---|---|---|
| 1 (tightest) | `*` `/` `%` | left |
| 2 | `+` `-` | left |
| 3 | `<` `>` `<=` `>=` | left |
| 4 (loosest) | `==` `!=` | left |

Standard C ordering. Two-character operators (`==`, `!=`, `<=`, `>=`) are matched with lookahead before their single-character prefixes, so `a<=b` lexes as one token, not `<` followed by a stray `=`.

### 5.3 Literals

**Integer:** a decimal digit run, mirroring how identifiers are scanned. No hex, no underscores, no floating point. **No leading `-`** — unary negation is not supported; a `-` where a primary expression is expected is a parse error naming this explicitly (`unexpected '-': unary negation is not supported (out of scope); did you mean a binary '-'?`). A literal exceeding `2147483647` — the max value of a C `int`, which is how `Int` lowers — is a parse-time error naming the reason.

**Boolean:** `true` / `false`. Contextual (§1.2) — recognized only in expression (primary) position.

No string, character, or floating-point literal exists.

### 5.4 The eleven binary operators

All eleven require both operands to type as `Int` — including `==`/`!=`; equality is not currently defined for any other type (§12.3, open question).

| Operators | Result type | Notes |
|---|---|---|
| `+` `-` `*` | `Int` | |
| `<` `>` `<=` `>=` `==` `!=` | `Bool` | |
| `/` `%` | `Result<Int, DivByZero>` | **Partial — not `Int`.** See below. |

**Division and modulo are partial operators.** `a / b` and `a % b` yield `Result<Int, DivByZero>`, not `Int`. `DivByZero` is the built-in enum from §2.2. The divisor is evaluated exactly once, and — as of the fix in `5998702` — so is the left operand, unconditionally, before the zero-check; an earlier version of this codegen only evaluated the left operand on the nonzero-divisor path, which meant a left operand consuming a linear resource leaked it whenever the divisor was zero.

**Using the unwrapped result where an `Int` is expected is caught only when it feeds another binary operator, not generally.** `(a / b) + c` is rejected — `left operand of '+' must be Int` — because the `+` case checks both its operands. But the checker has no general call-argument or return-type compatibility check anywhere — not specific to division, and not otherwise documented in this reference: `take(a / b)` where `take(n: Int)` checks with **zero errors**, and a `let`-bound division result later returned or passed on is equally unchecked. Both produce C that fails to compile. This is not a narrow edge case — a call argument and a return position are at least as common as feeding another operator, and only the operator case is caught. `?` (or a `match`) is required to use a division/modulo result as an `Int` in any position; the checker only enforces that requirement in one of the positions where it matters.

```fit
fn div_mod_demo(a: Int, b: Int) -> Result<Int, DivByZero> {
    let q = (a / b)?
    let r = (a % b)?
    Ok(q + r)
}
```

### 5.5 Grouping

`( expr )` is parser-only sugar — no AST node exists for it; the parser returns the inner expression directly.

**A trailing `?` after a group attaches correctly** — `(a / b)?` parses as intended, unwrapping the division's `Result`. This is not automatic: the grouping branch in `parsePrimary` explicitly calls the same `parseTry` step every other primary production calls before returning, mirroring how `Ok(...)`/`Err(...)` already handled their own parentheses. A grouping implementation that instead returned the inner expression with no further step would silently drop the `?` — traced and avoided, not a theoretical risk (`FIT-analysis-try-precedence.md`).

### 5.6 `?` binds at the primary level, not around the whole expression

`?` is checked once, immediately after each primary is parsed — before any binary operator at that position is considered. Consequently `a / b?` parses as `a / (b?)` (`?` applies to `b` alone, which must itself be a `Result`), not `(a / b)?`. This falls out of `parseTry`'s position in the grammar without any operator-precedence special-casing for `?` specifically; layering the binary-operator levels above primary parsing was sufficient (`FIT-analysis-try-precedence.md` §1.1).

### 5.7 `if` accepts any expression type

`if`'s condition is any `expr` — the checker does not currently require it to type as `Bool` (open question, §12.3).

---

## 6. Control flow

### 6.1 Conditionals

```fit
if cond {
    // body
} else {
    // body
}
```

`if` is a statement — it produces no value. `else` is mandatory; there is no bare `if` without one. Both branches share the surrounding scope; a linear value live before the `if` must be consumed on every branch or none — inconsistent disposal is a compile error naming the binding (`linear value 'x' must be consumed on all branches`).

### 6.2 Loop

```fit
loop {
    // body
    break
}
```

A loop whose body does not change any live binding's typestate type-checks normally. One that does is a compile error naming the binding, its start- and end-of-iteration typestate, and directing the programmer to recursion instead: `loop body changes typestate of 'x' from 'A' to 'B'; use recursion instead`.

`break` exits the loop. A linear value introduced *inside* the loop body must be consumed before a `break` that exits with it still owned, per §4.2's scope-exit rule. This section makes no claim about a linear value from *outside* the loop being repeatedly consumed inside a loop that never breaks — that shape is a separately filed, open question, not addressed by this construct's documented behavior either way.

### 6.3 Match

```fit
match expr {
    Variant             => body,
    Variant(x)          => body,
    EnumName.Variant    => body,
    EnumName.Variant(x) => body,
    _                   => body,
}
```

`match` is a statement. Each arm has its own scope; payload bindings live only in the arm body and must satisfy §4.2. A linear scrutinee (a resource, or a direct-variable reference to a linear enum) is consumed by the match.

**Exhaustiveness is enforced** for a scrutinee whose type resolves to a declared enum: `match on 'E' is not exhaustive — missing variant(s): X, Y`. **[divergence found]** — the prior document stated exhaustiveness was unenforced and deferred to v0.2; it is enforced (`checker.ts` `case "match"`, rule 9 in `poc-findings.md`'s count). Exhaustiveness is skipped for scrutinees that don't resolve to a known declared enum (an unresolved extern return type, or `Result`, which is not itself registered as a checkable enum — a separately filed limitation).

**A wildcard `_` covering any variant with a linear payload is a compile error** — `wildcard arm covers variant(s) with linear payload: X — destructure explicitly to consume`. **[divergence found]** — the prior document said covering a "typestate-bearing" variant with `_` was allowed, discarding the per-state guarantee; the actual condition checked is broader and stricter (any linear payload, not specifically typestate-bearing ones) and it is rejected, not allowed. A wildcard over variants carrying no linear payload is unaffected.

### 6.4 Error propagation

```fit
expr?
```

On `Err(e)`: widens `e` to the enclosing function's declared error type per flat membership (§2.3) and returns early; any linear value still owned in the enclosing scope is auto-cleaned. On `Ok(v)`: unwraps to `v` and continues.

Errors, verified against `checker.ts`'s exact message text:
- Non-`Result` inner expression: `'?' applied to non-Result type`.
- Enclosing function doesn't return `Result`: `'?' in a function that does not return Result`.
- Incompatible propagated error type: `cannot propagate error type 'X' — not a member of 'Y' declared by '<fn>'`.

Where `?` can attach syntactically — after any primary, including a parenthesized group — is specified in §5, not here; this section covers only the operator's runtime and type-checking behavior, unchanged from before this round.

---

## 7. Capabilities

```fit
fn serve(req: Request) using Net -> Result<Response, IoError>
fn charge(token: AuthToken) using Net, ChargeCard -> Result<Receipt, PaymentError>

select Read from Fs
select Read, Write from Fs
```

Capabilities are PascalCase. Atoms compose into flat bundles (`Fs = Read + Write + …`); `select` projects one or more atoms out of a bundle already in scope. The source bundle is not consumed — capabilities are unrestricted unless a program declares one linear.

**Enforcement is implemented at compile time**, not merely recognized as syntax: a call site whose callee requires `Cap` and whose caller-scope lacks it is `missing capability 'Cap' required by '<fn>'` (`checker.ts`, `case "call"`). **[divergence found]** — the prior document said capability enforcement was "out of scope for the PoC checker and v0.1... the syntax is recognized; full enforcement arrives in a later phase." That undersold what's implemented: requirement-presence checking is real and runs today.

What is **not** implemented: the "strict resolution — exactly one capability of a given type in scope, or compile error" duplicate-detection FIT-SPEC-v2.md §5 describes. The checker's capability scope is a `Set<string>` of currently-satisfied names — adding the same capability name twice is a no-op, and nothing in the current model represents two *distinct* instances of the same capability type coexisting (there is no way in v0.1 syntax to hold or pass a capability as a first-class value more than once). Whether that makes the duplicate-detection rule currently unreachable rather than unenforced is not resolved here — reported, not adjudicated.

---

## 8. Result and error handling

```fit
Ok(value)
Err(error)

Result<T, E>

type RequestError = ParseError | DbError | NetworkError

fn handle(req: Request) using Net -> Result<Response, RequestError> {
    let parsed = parse(req)?
    let row    = query(parsed)?
    Ok(build_response(row))
}
```

`Ok`/`Err` are constructors, not function calls. Wrapping a **named variable** holding a linear value consumes it — `Ok(w)` where `w: Widget` marks `w` moved. Wrapping a **call result directly** does not: `Ok(make_widget())` does not track `make_widget()`'s return as consumed, because there is no named binding for the checker to mark — a filed limitation (`poc-findings.md`, "`Ok(call_expr)` not consumed"), not new to this document but worth stating precisely rather than the unqualified "wrapping consumes the value" the prior text implied.

---

## 9. Early disposal

```fit
drop(conn)
```

`drop` is a built-in consuming sink, not a reserved word (§1.2) — it is recognized only by name at a call site. `drop(x)` where `x` is a bare variable consumes it immediately, firing cleanup at the call site rather than scope exit. `drop` with anything other than exactly one variable argument is a compile error: `drop requires a single variable argument`.

---

## 10. Modules (v0.1)

### 10.1 Import form

```fit
import session
import transport
```

Imports all top-level declarations from `session.fit`/`transport.fit`, resolved relative to the importing file's own directory, into the current file's scope. Import declarations must appear before every other declaration in a file — an `import` after any other top-level decl is `import declarations must appear before all other declarations`.

### 10.2 Resolution rules (`src/loader.ts`)

1. **Flat namespace** — imported declarations share one namespace with the importing file; no qualifiers.
2. **File-relative** — `import foo` resolves to `foo.fit` in the same directory. No subdirectories, no `..`, no absolute paths.
3. **Transitive** — A imports B imports C makes C's declarations visible in A.
4. **Diamond-safe** — a file reachable by two import paths is included once.
5. **Cycles are compile errors** — `import cycle detected: a.fit → b.fit → a.fit`, naming the path.
6. **Duplicate top-level names are compile errors**, across files or within one — except enum variant names, which follow §2.5.

### 10.3 What v0.1 modules deliberately do not do

No visibility modifiers, no qualified or selective imports, no module hierarchy, no separate compilation (every `import` is re-parsed and re-checked per invocation), no package management.

---

## 11. Reference programs

`payment.fit`, `smtp.fit`, and `drain.fit` — the three PoC canonical programs — type-check unchanged under v0.1 syntax.

`examples/postgres/postgres.fit` exists as a substantial single-file network-protocol client exercising the language's in-scope domain, but it is a single file — it does not itself exercise the module system (§10). No multi-file worked example currently accompanies this document.

---

## 12. What is out of scope for v0.1

Three categories, not two. The prior document's two-category split (hard-out-of-scope / deferred) is exactly why literals and operators ended up recorded nowhere: neither rejected nor deferred, and nothing recorded that the question itself was open.

### 12.1 Excluded — decided against, will not be added

These fail the functional-discipline filter (§13) and are not future candidates:

- Methods with an implicit receiver (`this`/`self`).
- Inheritance (single, multiple, or trait-as-inheritance).
- Virtual dispatch / runtime polymorphism on value identity.
- Visibility modifiers (`pub`, `private`, `export`).
- Classes, objects, prototype chains.
- Aliased mutable references / shared mutable state.
- Implicit conversions beyond the explicit, bounded `?` widening.
- Operator overloading.
- Macros/metaprogramming that synthesize type-attached behavior.

### 12.2 Deferred — wanted, not built, no blocker

Additive whenever scheduled; nothing about the current design prevents adding these:

- String literals.
- Unary operators (`-x`, `!x`).
- Field access (`r.x`) — free-function accessors remain the v0.1 form.
- Arrays, indexing, tuples, casts, ranges.
- Generics beyond a single typestate parameter `<S>` on resources.
- Closures, first-class functions.
- Method-call sugar (`c.send(b)` → `send(c, b)`).
- Module hierarchy, visibility-aware/qualified/selective imports, separate compilation.
- Async/concurrency.
- Regions/cyclic structures.
- Composite typestate composition — cross-layer state invariants (§2.4).
- Mutual recursion lend/move inference — actually **implemented**, not deferred. **[divergence found]** — the prior document listed this as requiring explicit annotation in the meantime; `types.ts`'s Pass 2 runs a fixed-point iteration over the call graph specifically to resolve forward references and mutual-recursion cycles without one, closed per `poc-findings.md`.
- Expression-form `if` and `match` — both remain statements (§6.1, §6.3).
- Nested-alias expansion for error unions (§2.3).
- Two-phase cleanup (`fallback-preferred` warning) — parses, has no effect (§2.4).
- Integer-tag enum variants (`Declined = 1`).
- Standard library.
- Package management.

### 12.3 Open questions — blocked on a decision, not built, question stated

- **`if` condition typing.** Comparison operators yield `Bool` (§5.4), but `if`'s condition currently accepts any expression type — `should_stop`, an extern used as a condition across different test programs, is declared returning `Int` in one, `String` in another, `Bool` in a third, all accepted identically. **The decision: require the condition to type as `Bool` — which breaks the three existing programs that pass a non-`Bool` condition today — or leave it unconstrained.** A round is scheduled.
- **Equality on non-`Int` types.** `==`/`!=` are implemented for `Int` operands only (§5.4). **The decision: extend equality to `Bool`, to enums (which would need per-variant comparison, not a one-line change), to plain types generally — or leave equality Int-only.** Not settled by this document.
- **Capability duplicate-instance resolution.** `FIT-SPEC-v2.md` §5 describes strict single-capability-per-type resolution; the current name-presence model has no way to represent two distinct instances of one capability type coexisting, so the rule may be currently unreachable rather than unenforced (§7). **The question: does v0.1's capability model need to represent multiple instances at all, or is the spec describing a later capability model?** Not resolved here.

---

## 13. Functional discipline — a filter for proposed features

FIT is functional-leaning by design constraint, not decoration: *"Types declare data and (for resources) destruction. All behavior is free functions. No methods, no inheritance, no dispatch, no `this`, no privacy levels."* (`FIT-SPEC-v2.md` §8.)

### 13.1 The filter — three questions

A proposed feature that fails any of these is rejected, not deferred, absent an explicit recorded exception:

1. **Does it attach behavior to a type?** Anything that makes a function "belong to" a type — an implicit receiver, traits-as-inheritance, identity-keyed dispatch — fails. Pure sugar that desugars to a free-function call without an implicit receiver does not (§13.3).
2. **Does it introduce mutable state outside an explicit binding?** FIT's mutability is `let mut`, scoped and visible at the binding; hidden mutation (rewritten fields through shared references, ambient globals) fails.
3. **Does it require a new dispatch mechanism?** Anything requiring the runtime or call site to choose an implementation by value identity fails; compile-time-resolved mechanisms (capabilities, typestate, named unions) are FIT's polymorphism.

### 13.2 Fails the filter

`this`/`self` (Q1); visibility modifiers (Q1 — module-scope visibility already covers the legitimate cases without implying types own implementation); inheritance and trait hierarchies (Q1+Q3); aliased mutable references (Q2); macros synthesizing type-attached behavior (Q1, regardless of what the generated code looks like).

### 13.3 Passes the filter

Capabilities (compile-time signature requirements, no dispatch); typestate (compile-time-resolved over a phantom parameter); named transparent error unions with `?` widening (flat membership check, no dispatch); the module system (§10 — imports bring declarations into scope, no visibility, no attached behavior); method-call sugar, *if and only if* it introduces no implicit receiver binding (§12.2, deferred).

### 13.4 Relation to §12

§12.1 (excluded) lists features that fail this filter today. §12.2 (deferred) lists features that pass but are not built. The boundary between the two categories is the filter itself; §12.3 (open questions) is orthogonal — those are unresolved regardless of what the filter would say once the underlying decision is made.

---

*End of v0.1 syntax reference.*
