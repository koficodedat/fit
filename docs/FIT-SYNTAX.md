# FIT — Syntax Reference

**Version:** v0.1
**Status:** v0.1 surface syntax. Settled forms are firm; deferred items are explicit.
**Supersedes:** Draft 1 (PoC syntax reference).

**Changes from PoC Draft 1:**
- Keyword categories clarified (§1.2 — reserved set lifted from FIT-SPEC §9).
- Parameterized resource types in field positions noted (§2.4).
- Variant name resolution settled (§2.5 — dot syntax; `::` is not used).
- Extern annotation rule added (§3.6 — explicit `move`/`lend` at FFI boundary).
- Let-shadowing and scope-exit enforcement made explicit (§4.1, §4.2).
- Match exhaustiveness noted as deferred (§5.3).
- Modules added (§9 — flat namespace, file-relative, no visibility).
- Out-of-scope list updated for v0.1 (§11 — split into hard out-of-scope and deferred).
- Functional discipline filter added (§12).

**Scope note:** This is a checker/reader target, not a grammar specification. The
implementation is a hand-written recursive-descent parser over these forms.

---

## 1. Notation conventions

### 1.1 Lexical

- Single-line comments: `// ...` to end of line.
- Block comments: `/* ... */`.
- Identifiers: ASCII letters, digits, underscore; must not start with a digit.
- Keywords are lowercase.
- Type names and capability names are PascalCase.
- Value and function names are snake_case.

### 1.2 Keyword categories

**Reserved keywords** (cannot appear as identifiers — these are taken by the language
or held in reserve per FIT-SPEC §9):

| Category | Keywords |
|----------|----------|
| Declarations | `resource`, `capability`, `record`, `enum`, `type`, `fn`, `import` |
| Memory modes | `linear`, `affine`, `mut` |
| Resource fields | `cleanup` |
| Statements & control flow | `let`, `if`, `else`, `loop`, `break`, `match`, `drop` |
| Capabilities | `using`, `select`, `from` |
| Reserved-for-future / rejected synonyms | `data`, `struct`, `sum`, `union`, `error` |

Reserved synonyms (`data`, `struct`, `sum`, `union`, `error`) are held so that future
designs can adopt them without a breaking rename. They are not currently used by the
grammar.

**Contextual keywords** (recognized only in specific positions; valid identifiers
elsewhere):

`move`, `lend`. These appear only in the parameter-annotation position — between a
parameter's colon and its type:

```fit
fn close(c: move SmtpConn<Closing>) -> Result<(), SessionError>
fn read (c: lend Conn<Ready>) -> Bytes
```

Outside that position, `move` and `lend` are ordinary identifiers — a local variable
named `move` is legal.

Tooling note: syntax highlighting must be position-aware to avoid false-positive
keyword coloring on identifiers named `move` or `lend`.

---
## 2. Type declarations

### 2.1 Product types — `record`

```fit
record Point {
    x: Int,
    y: Int,
}
```

Fields are comma-separated. Trailing comma allowed. A `record` is plain data — it never
declares cleanup, and is therefore never a resource even if a field is itself a
resource. Records group data; they do not own destruction.

(FIT-SPEC O5 is closed at `record` for v0.1. `data` and `struct` remain reserved per §1.2.)

### 2.2 Sum types — `enum`

```fit
// Unit variants (no payload)
enum Direction { North, East, South, West }

// Variants with payload
enum ConnEvent {
    Data(Bytes),
    Error(String),
    Closed,
}

// Typestate states (unit variants used as type-level markers)
enum TcpState { Fresh, Ready, Closing }
```

Variants are comma-separated. Payload is a single type in parentheses. Multiple payload
fields are wrapped in a record: `Variant(SomeRecord)`. No integer tags (`= 1`) — codegen
concern, out of scope.

An enum is **linear** if any variant carries a linear payload (a resource). It is
**unrestricted** otherwise. Linearity is derived from the variants, not declared on the
enum itself.

(FIT-SPEC O5 is closed at `enum` for v0.1. `sum` and `union` remain reserved per §1.2.)

### 2.3 Named error union aliases

```fit
type SessionError = SmtpError | IoError
type HttpError    = ParseError | NetworkError | DbError
```

`|` is used **only** for named union aliases. This is syntactically distinct from `enum`
variant declaration (commas, no `|`). The `?` operator (§5.4) implicitly widens a member
error type to its declared union; widening between two unrelated types is a compile
error.

**Flat membership only.** An alias of aliases (`type Outer = Inner | Z` where `Inner` is
itself an alias) is not transitively expanded. Widening checks flat membership only.
Nested-alias expansion is a deferred design question.

### 2.4 Resources — `resource`

```fit
resource File {
    handle:  FileHandle,
    cleanup: force_close,        // names the infallible fallback function
}

resource Conn<S> {               // S is the typestate parameter
    sock:    TcpSocket,
    cleanup: tcp_force_close,
}
```

A `resource` is always linear (FIT-SPEC §2.3 — declaring cleanup forces linearity). The
`cleanup` field names the infallible fallback function that fires at scope exit if the
resource is still owned.

For resources where explicit teardown is preferred, mark the cleanup `fallback`:

```fit
resource TxConn<S> {
    sock:     TcpSocket,
    cleanup:  fallback tcp_force_close,   // compiler warns if auto-cleanup fires
}
```

The `<S>` typestate parameter is required when the resource participates in typestate
transitions. `S` is a phantom type — compile-time state information only, no runtime
data.

**Parameterized resource types in field positions.** A `record` or `resource` field may
use a parameterized resource type:

```fit
resource HttpSession {
    sock:    TcpConn<Connected>,
    cleanup: http_force_close,
}
```

The inner type's typestate parameter is parsed and recorded in the AST but **not
checked for cross-layer invariants** in v0.1. The composite typestate question — "if
the outer session is in `Handling`, does that constrain the inner connection's state?"
— is deferred to v0.2. v0.1 treats inner typestate as opaque.

### 2.5 Variant name resolution

Variant names need not be globally unique across enums. A bare variant name `V`
resolves unambiguously if exactly one declared enum contains `V`. If multiple enums
declare `V`, the use site must qualify using **dot syntax**: `EnumName.V`.

```fit
enum IoError   { NotFound, PermissionDenied }
enum HttpError { NotFound, BadRequest }

fn handle(io: IoError, http: HttpError) -> () {
    match io {
        IoError.NotFound  => { /* ... */ },     // qualified — required
        PermissionDenied  => { /* ... */ },     // bare — unambiguous
    }
    match http {
        HttpError.NotFound => { /* ... */ },    // qualified — required
        BadRequest         => { /* ... */ },    // bare — unambiguous
    }
}
```

**Resolution rule:**

1. Bare `V` at a use site: scan all declared enums.
   - Exactly one match → resolve.
   - Zero matches → `unknown variant 'V'`.
   - Two or more matches → `ambiguous variant 'V' — declared by enums X, Y; use 'X.V' or 'Y.V' to disambiguate`.

2. Qualified `EnumName.V`: look up `EnumName`.
   - Missing → `unknown enum 'EnumName'`.
   - Found, but no `V` member → `enum 'EnumName' does not declare variant 'V'`.
   - Found with `V` → resolve.

**Syntax — dot only.** FIT does not use Rust-style path syntax (`::`).

**Within a single match, arms are resolved independently.** Bare and qualified arms may
mix in the same match; the scrutinee's enum provides context.

---
## 3. Function signatures

### 3.1 Basic form

```fit
fn name(param: Type, param2: Type) -> ReturnType
```

### 3.2 With capability requirements

```fit
fn name(param: Type) using Cap -> ReturnType
fn name(param: Type) using Cap1, Cap2 -> ReturnType
```

### 3.3 With Result return

```fit
fn name(param: Type) using Cap -> Result<ReturnType, ErrorType>
```

### 3.4 Returning unit

```fit
fn name(param: Type) -> ()
fn name(param: Type) using Cap -> Result<(), ErrorType>
```

### 3.5 Lend vs. move — the inference rule (no sigil)

For a **bodied** function, whether a parameter is **lent** or **consumed (moved)** is
inferred from the function body and frozen in the published signature:

- **Move:** the body transfers the parameter onward — returns it (in any typestate),
  stores it into an aggregate, or passes it to another consuming function.
- **Lend:** the body only uses the parameter — passes it to other lending functions,
  reads from it — and never transfers it onward. The caller retains ownership after
  the call.

The compiler infers this once per function and records it as part of the function's
type. A body change that would flip lend→move (or vice versa) is a compile error at
the signature boundary.

Examples:

```fit
// Lend: Conn<Ready> not transferred onward — caller keeps it after.
fn read_data(conn: Conn<Ready>) -> Data

// Move: Conn returned in new typestate — ownership transferred.
fn handshake(conn: Conn<Fresh>) -> Result<Conn<Ready>, NetError>

// Move on conn: stored into pool.
fn pool_add(pool: Pool, conn: Conn<Ready>) -> Pool
```

The move/lend property is always displayable in tooling, even though it is not
written in source.

### 3.6 Extern functions — explicit annotation required

Functions without bodies (externs, FFI declarations) cannot be inferred. For any
extern with a linear parameter (a resource, or a linear enum), the programmer must
supply an explicit `move` or `lend` annotation between the colon and the type:

```fit
fn close(c: move SmtpConn<Closing>) -> Result<(), SessionError>
fn send_message(c: lend SmtpConn<Ready>, msg: Message) -> Result<(), SessionError>
```

An extern with a linear parameter and no annotation is a compile error.

Non-linear parameters never require annotation. Annotations on non-linear parameters
are accepted (treated as `lend`) but contribute no information.

**Annotations on bodied functions.** A bodied function may carry an explicit
annotation; it overrides inference and the body is checked against it. Omitting it
triggers body inference (§3.5).

**Where the no-sigil property holds.** Within FIT code — call sites and bodied
signatures — no `move`/`lend` markers appear. The explicit annotation appears only at
the FFI boundary, where the checker has no body to inspect and the information must
be supplied by the library author. This is FIT-SPEC §1.3 pillar #2 as revised
post-stdlib-probe.

---
## 4. Bindings and mutation

```fit
let x = expr            // bind name x to expr; x is immutable (cannot rebind)
let mut x = expr        // bind name x; x may be rebound
x = expr                // rebind x (only valid if declared mut)
```

`mut` is orthogonal to the value's memory mode (FIT-SPEC §2.2). A `let mut conn`
holding a linear resource is still linear — `mut` only permits the name to be
rebound. Each rebind consumes the previous value.

### 4.1 Let-shadowing

A `let x = ...` inside an inner scope shadows any outer `x` for the duration of the
inner scope. The outer binding is restored when the inner scope exits.

If the inner expression *uses* the outer binding (e.g. `let c = greet(c)?`), the outer
value is consumed at that point — its identity is moved into the new binding. If the
inner expression does not reference the outer name, the outer binding remains live
and the shadow is purely lexical.

Straight-line typestate transitions are written with shadowing:

```fit
let c = connect(host)?      // c: Conn<Fresh>
let c = greet(c)?           // old c consumed; new c: Conn<Greeted>
let c = auth(c, creds)?     // old c consumed; new c: Conn<Authed>
```

After each shadow, the old typestate is unavailable.

### 4.2 Scope-exit enforcement

A linear value owned at any scope exit — function return, branch end, match arm end,
loop body end — is a compile error if not consumed before that exit. This applies
uniformly to all linear values: resources and linear enums alike.

The patterns that satisfy the rule:
- Consume via a transferring call.
- Consume via `drop(x)` (§8).
- Return the value.

The error message names the binding, its type, and the scope-exit point.

---

## 5. Control flow

### 5.1 Conditionals

```fit
if cond {
    // body
} else {
    // body
}
```

`if` is a **statement** in v0.1. It does not produce a value. (Expression-form `if`
is a candidate for v0.2 — the functional-leaning direction would compose `if` with
let-binding.)

Both branches share the surrounding scope's bindings. Both branches must consume the
same set of linear values introduced before the `if`: a linear value live at the `if`
must be consumed on every branch, or on no branch. Inconsistent disposal across
branches is a compile error naming the binding and the inconsistent paths.

### 5.2 Loop

```fit
loop {
    // body
    break
}
```

A `loop` whose body does **not** change any binding's typestate typechecks normally.

A `loop` whose body would change a binding's typestate is a compile error. The message
names the binding, the start-of-iteration type, the end-of-iteration type, and tells
the programmer to use recursion instead (FIT-SPEC §6).

`break` exits the loop. Linear values introduced inside the loop body must be
consumed before `break` per §4.2.

### 5.3 Match

```fit
match expr {
    Variant             => body,
    Variant(x)          => body,
    EnumName.Variant    => body,           // qualified — see §2.5
    EnumName.Variant(x) => body,
    _                   => body,
}
```

`match` is a statement. Each arm introduces its own scope; payload bindings live only
in the arm body and must satisfy scope-exit enforcement (§4.2).

If the scrutinee is a linear value (a resource or a linear enum), the match consumes
it. Each arm independently must consume any linear bindings the arm introduces (the
payload binding, plus any linear `let` bindings declared inside the arm).

**Exhaustiveness.** v0.1 does not enforce match exhaustiveness. A non-exhaustive
match compiles. Exhaustiveness checking is deferred to v0.2 — it requires payload-
type tracking that is not in place yet.

The wildcard `_` is available. Covering typestate-bearing variants with `_` is
allowed but discards the per-state safety guarantee for those variants.

### 5.4 Error propagation

```fit
expr?
```

On `Err(e)`: widens `e` to the enclosing function's declared error type per the flat-
membership rule (§2.3) and returns early. Any linear values still owned in the
enclosing scope are auto-cleaned (their declared `cleanup` runs) before return.

On `Ok(v)`: unwraps to `v` and continues.

**Errors:**
- `?` in a function whose return type is not `Result<_, _>` is a compile error.
- `?` propagating an error whose type is neither equal to nor a flat member of the
  enclosing function's error type is a compile error. The message names both error
  types and the enclosing function.

---
## 6. Capabilities

```fit
// Declaring a capability requirement in a signature
fn serve(req: Request) using Net -> Result<Response, IoError>
fn charge(token: AuthToken) using Net, ChargeCard -> Result<Receipt, PaymentError>

// Projecting atoms from a bundle
select Read from Fs
select Read, Write from Fs
```

Capabilities are PascalCase. Atoms (`Read`, `Write`, `Net`, `Console`, …) compose
into flat bundles (`Fs = Read + Write + …`). `select` projects one or more atoms from
a bundle.

**Strict resolution.** Exactly one capability of a required type must be in scope at
a call site, or it is a compile error. Holding a bundle does not auto-satisfy a
member-atom requirement — explicit `select` is required (FIT-SPEC O1, leaning
"project explicitly").

The bundle is not consumed by `select` — capabilities are unrestricted unless
explicitly linear.

Capability resolution implementation (threading, enforcement at runtime) is **out of
scope for the PoC checker and v0.1** (FIT-SPEC §10). The syntax is recognized; full
enforcement arrives in a later phase.

---

## 7. Result and error handling

```fit
// Constructors
Ok(value)
Err(error)

// Type
Result<T, E>

// Named union alias
type RequestError = ParseError | DbError | NetworkError

// Usage
fn handle(req: Request) using Net -> Result<Response, RequestError> {
    let parsed = parse(req)?        // ParseError → RequestError (flat member)
    let row    = query(parsed)?     // DbError    → RequestError (flat member)
    Ok(build_response(row))
}
```

`Ok(v)` and `Err(e)` are constructors, not function calls. Wrapping a linear value in
`Ok` or `Err` consumes the value.

Widening rules: see §2.3 (flat membership) and §5.4 (the `?` operator).

---

## 8. Early disposal

```fit
drop(conn)
```

`drop` is a built-in consuming sink. After `drop(conn)`, `conn` is unavailable.
Cleanup fires at the `drop` call site, not at scope exit. Any linear value can be
passed to `drop` for explicit mid-scope cleanup.

This is not a special mechanism — `drop` follows from the move/cleanup rules: it is a
consuming function whose body transfers nothing onward, so the cleanup fires at the
call site (FIT-SPEC §3).

`drop` takes exactly one variable argument. `drop(expr)` where `expr` is not a bare
variable is a compile error.

---
## 9. Modules (v0.1)

### 9.1 Import form

```fit
import session
import transport
```

Imports all top-level declarations from `session.fit` and `transport.fit` (located in
the same directory as the importing file) into the current file's scope.

Import declarations must appear **before** all other top-level declarations in a
file. An `import` after any other declaration is a compile error.

### 9.2 Resolution rules

1. **Flat namespace.** All imported declarations share one namespace with the
   importing file. No qualifiers: `Connection`, not `session.Connection`.
2. **File-relative.** `import foo` resolves to `./foo.fit` relative to the importing
   file's directory. No subdirectories, no `..`, no absolute paths.
3. **Transitive.** If A imports B and B imports C, all of C's declarations are
   visible in A.
4. **Diamond-safe.** If A imports B and C and both import D, D's declarations appear
   exactly once in the assembled program.
5. **Cycles are compile errors.** A → B → A (directly or transitively) is rejected
   with a clear message naming the cycle path.
6. **Duplicate top-level names are compile errors** — across imports or within a
   single file. The error names both source locations. Enum variant names are the
   exception: they follow §2.5 and may coexist across enums.

### 9.3 What v0.1 modules deliberately do NOT do

Deferred to v0.2 or later:

- No visibility modifiers (`pub`, `private`, `export`). All declarations are
  accessible. See §12 for why visibility is treated with caution in FIT.
- No qualified imports (`import session as s`).
- No selective imports (`import session.{Connection}`).
- No module hierarchy (no subdirectories, no nested paths).
- No separate compilation. Every `import` re-parses and re-checks (memoized per
  compilation invocation).
- No package management (no manifest, no registry).

The v0.1 module system is intentionally the minimum that lets programs span files.

---

## 10. Reference programs

The canonical PoC programs (`payment.fit`, `smtp.fit`, `drain.fit`) type-check
unchanged under v0.1 syntax. Their full text and per-program checker assertions are
in §10 of the PoC syntax draft and in `tests/` in the repository.

A v0.1 multi-file example — the network-protocol implementation that is v0.1's
in-scope domain (FIT v0.1 scoping document) — lands alongside the rest of v0.1
execution and is added to this section once written.

---
## 11. What is out of scope for v0.1

These items are not in v0.1. The split below reflects the functional discipline
filter (§12). The distinction is important: deferred features create gradual
pressure to re-enter the language; hard out-of-scope features should not.

### 11.1 Hard out-of-scope — not planned, ever

These features fail the §12 filter. They are not future v0.x candidates; they are
off the table for FIT as designed:

- **Methods with an implicit receiver binding** (`this`, `self`). Even with method-
  call sugar (see §11.2 below), the receiver remains an ordinary parameter, never
  implicitly bound to the type body.
- **Inheritance** (single, multiple, or trait-as-inheritance hierarchies). Attaches
  behavior to types and introduces dispatch.
- **Virtual dispatch / runtime polymorphism on value identity.** FIT's polymorphism
  is compile-time: capabilities, typestate, named unions.
- **Visibility modifiers** (`pub`, `private`, `export`). Their purpose in other
  languages is to protect implementation invariants of types that own behavior.
  FIT's types own only data and (for resources) one cleanup; module-scope visibility
  (§9) covers all legitimate cases. Adding visibility would imply types own
  implementation — the model FIT rejects.
- **Classes, objects, prototype chains.**
- **Aliased mutable references / shared mutable state.** Linearity and lending cover
  the legitimate uses; aliased mutability is the foundation of OOP object identity
  and is not added.
- **Implicit conversions** beyond the explicit, bounded `?` widening (§5.4).
- **Operator overloading.**
- **Macros / metaprogramming that synthesize type-attached behavior.**

### 11.2 Deferred to a later version — not in v0.1 but consistent with FIT's direction

These features pass the §12 filter (or could pass with care) but are not in v0.1:

- Generics beyond a single typestate parameter `<S>` on resources.
- Closures, first-class functions.
- Method-call sugar (`c.send(b)` desugaring to `send(c, b)`) — FIT-SPEC O6,
  cosmetic, semantics-preserving.
- Field access syntax (`r.x`). Free-function accessors remain the v0.1 form.
- Module hierarchy, visibility-aware imports, qualified imports, selective imports,
  separate compilation.
- Async / concurrency (FIT-SPEC O4).
- Regions / cyclic structures (FIT-SPEC O3, O7).
- Composite typestate composition — cross-layer state invariants (§2.4).
- Match exhaustiveness enforcement (§5.3).
- Mutual recursion lend/move inference (explicit annotation required in the
  meantime).
- Expression-form `if` and `match` (§5.1, §5.3).
- Nested-alias expansion for error unions (§2.3).
- Two-phase cleanup (`fallback-preferred` warning) — reserved keyword only.
- Integer-tag enum variants (`Declined = 1`) — codegen concern.
- Standard library.
- Package management.

---
## 12. Functional discipline — a filter for proposed features

FIT is a **functional-leaning** language. That is not decoration; it is a design
constraint applied to every proposed feature. FIT-SPEC §8 records the locked
principle:

> Types declare data and (for resources) destruction. All behavior is free
> functions. No methods, no inheritance, no dispatch, no `this`, no privacy
> levels.

This section gives the operational test used to evaluate future proposals.

### 12.1 The filter — three questions

Before any proposed feature is accepted into FIT, it must answer the following
three questions. If it fails any of them, the feature is **rejected** — not
deferred, not re-scoped, rejected — unless the design authority makes an explicit,
recorded exception.

1. **Does it attach behavior to a type?**

   If the feature makes a function "belong to" a type — methods with an implicit
   `this`/`self` binding, traits-as-inheritance, prototype chains, dispatch keyed
   on a value's identity — it fails the filter. Free functions operating on values
   are FIT's only behavior model. (Pure sugar that desugars to a free-function
   call without introducing an implicit receiver binding does not fail this
   question; see §12.3.)

2. **Does it introduce mutable state outside an explicit binding?**

   FIT's mutability is `let mut`, scoped to a name, visible at the binding. A
   feature that introduces hidden mutation — object fields rewritten through
   shared references, ambient global state, accumulator patterns that rely on
   uninstrumented side effects — fails the filter.

3. **Does it require a new dispatch mechanism?**

   If the feature requires the runtime, or the compiler at the call site, to
   choose between implementations based on a value's identity (virtual dispatch,
   multiple dispatch, ad-hoc polymorphism without explicit witnessing), it fails
   the filter. Compile-time-resolved mechanisms — capabilities, typestate, named
   unions, signature-driven selection — are FIT's polymorphism.

### 12.2 Examples of features that fail the filter

- **`this`/`self` as an implicit receiver.** Q1 fail — the receiver becomes an
  implicit binding inside the function body, attaching the function to the type.
- **Visibility modifiers (`pub`, `private`).** In other languages, these protect
  implementation invariants of behavior-bearing types. FIT's types declare only
  data and (for resources) one cleanup; module-scope visibility (§9) covers all
  legitimate cases. Adding visibility would imply types own implementation — the
  model FIT rejects.
- **Inheritance and trait hierarchies.** Q1 and Q3 fail together.
- **Object identity with aliased mutable references.** Q2 fail.
- **Macros that synthesize type-attached methods.** Even if the macro output
  looks like free functions, the *practice* of generating type-attached behavior
  fails Q1.

### 12.3 Examples of features that pass

- **Capabilities** (compile-time signature requirements). No dispatch, no
  attachment; resolved at the call site as a signature requirement. Settled.
- **Typestate.** Compile-time-resolved polymorphism over a phantom parameter;
  operations on `Conn<Ready>` and `Conn<Closing>` are distinct free functions
  whose applicability is checked statically. Settled.
- **Named transparent error unions with `?` widening.** No dispatch; widening is
  a flat membership check at the `?` site. Settled.
- **The minimal module system (§9).** Imports bring declarations into scope; no
  visibility, no dispatch, no behavior attached to imports. Settled.
- **Method-call sugar (O6, deferred).** `c.send(b)` desugaring to `send(c, b)`
  passes the filter *if and only if* the sugar introduces no implicit receiver
  binding. The function remains free; the dot is purely notational.

### 12.4 The discipline

When a future probe surfaces a pain point and a proposed feature would address
it, the design-authority response is:

1. State the proposed feature concretely (syntax, semantics, what it compiles to).
2. Run it through the three filter questions explicitly.
3. If it fails, find a different solution — usually a free function, a new
   typestate, an additional capability, or a structural rearrangement.
4. If no filter-passing solution exists, the honest move is to record the
   constraint as a real boundary of the language, not to break the filter.

This is the same discipline that produced the "no methods, no inheritance" call
in the PoC. The filter formalizes that test so it can be applied consistently as
FIT grows.

### 12.5 Relation to §11

§11.1 (hard out-of-scope) lists features that fail this filter today.
§11.2 (deferred) lists features that pass the filter but are not in v0.1 yet.
The boundary between the two is the filter itself.

---

*End of v0.1 syntax reference.*
