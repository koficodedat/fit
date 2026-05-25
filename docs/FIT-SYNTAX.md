# FIT — Syntax Reference

**Version:** Draft 1 (Phase 1 output)
**Status:** Frozen for PoC. Surface syntax is concrete enough to implement the checker
and write the test programs. Non-PoC constructs are explicitly excluded.
**Scope note:** This is a checker/reader target, not a grammar spec. The PoC does not
need a full parser — a hand-written recursive descent over these forms is sufficient.

---

## 1. Notation conventions

```
// Single-line comment

/* Multi-line
   comment */
```

Keywords are lowercase. Capability names are always capitalized (`Net`, `Fs`, `ChargeCard`).
Type names are PascalCase. Value/function names are snake_case.

---

## 2. Type declarations

### 2.1 Product types — `record`

```fit
record Point {
    x: Int,
    y: Int,
}
```

Fields are comma-separated. Trailing comma allowed. All fields are plain data unless their
type is a resource (in which case the record is itself linear — it owns a resource).

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

Variants are comma-separated. Payload is a single type in parentheses. Multiple fields in
a variant are wrapped in a record: `Variant(RecordType)`. No integer tags (`= 1`) — that
is a codegen concern, out of PoC scope.

### 2.3 Named error union aliases

```fit
type SessionError = SmtpError | IoError
type HttpError    = ParseError | NetworkError | DbError
```

`|` is used **only** for named union aliases. This is distinct from `enum` variant
declaration (which uses commas). The `?` operator implicitly widens a member error type to
the declared union; explicit conversion is required otherwise.

### 2.4 Resources — `resource`

```fit
resource File {
    handle: FileHandle,
    cleanup: force_close,        // names the infallible fallback function
}

resource Conn<S> {               // S is the typestate parameter
    sock:    TcpSocket,
    cleanup: tcp_force_close,
}
```

A `resource` is always linear. The `cleanup` field names the infallible fallback function
that fires at scope exit if the resource is still owned. For resources with preferred
explicit teardown, mark the cleanup `fallback`:

```fit
resource TxConn<S> {
    sock:     TcpSocket,
    cleanup:  fallback tcp_force_close,   // compiler warns if auto-cleanup fires
}
```

The `<S>` typestate parameter is required when the resource participates in typestate
transitions. `S` is a phantom type — it carries no runtime data, only compile-time state
information.

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

Whether a parameter is **lent** or **consumed (moved)** is inferred from the function body
and frozen in the published signature. The rule:

- **Move:** the body transfers the parameter onward — returns it (in any typestate), stores
  it into an aggregate, or passes it to another consuming function.
- **Lend:** the body only uses the parameter — passes it to other lending functions, reads
  from it — and never transfers it onward. The caller retains ownership after the call.

The compiler infers this once per function and records it as part of the function's type.
A body change that would flip lend→move is a compile error at the signature boundary.
The move/lend property is **always displayed** in tooling even though not written.

Examples:

```fit
// Lend: Conn<Ready> not transferred onward — caller keeps it after
fn read_data(conn: Conn<Ready>) -> Data

// Move: Conn returned in new typestate — ownership transferred
fn handshake(conn: Conn<Fresh>) -> Result<Conn<Ready>, NetError>

// Move on conn: stored into pool (transferred into aggregate)
fn pool_add(pool: Pool, conn: Conn<Ready>) -> Pool
```

---

## 4. Bindings and mutation

```fit
let x = expr            // bind name x to expr; x is immutable (cannot rebind)
let mut x = expr        // bind name x; x may be rebound
x = expr                // rebind x (only valid if declared mut)
```

`mut` is orthogonal to the value's memory mode. A `let mut conn` holding a linear resource
is still linear — `mut` only permits the name to be rebound. Each rebind consumes the
previous value and binds the new one.

Straight-line typestate transitions use rebind:

```fit
let c = connect(host)?      // c: Conn<Fresh>
let c = greet(c)?           // old c consumed; new c: Conn<Greeted>
let c = auth(c, creds)?     // old c consumed; new c: Conn<Authed>
```

The old binding is unavailable after rebind. The checker enforces this.

---

## 5. Control flow

### 5.1 Conditionals

```fit
if cond {
    expr
} else {
    expr
}
```

Both branches must produce the same type. Both branches must consume any linear values
introduced before the `if` — a linear value live at an `if` must be consumed on every
branch.

### 5.2 Plain loop

```fit
loop {
    // body
    break
}
```

A plain `loop` whose body does **not** change any binding's typestate typechecks normally.
A `loop` whose body would change a binding's typestate is a **compile error** — the
compiler demands recursion instead. This is PoC question 3's test scenario.

### 5.3 Match

```fit
match expr {
    Variant        => body,
    Variant(x)     => body,
    Variant(x, y)  => body,    // only if variant wraps a record with two fields
    _              => body,
}
```

Match is exhaustive — the compiler rejects non-exhaustive patterns. This is the primary
construct for typestate dispatch and error handling. The wildcard `_` is available but
the PoC checker should warn when it covers a typestate variant (forces the programmer to
be explicit about state handling).

### 5.4 Error propagation

```fit
expr?
```

On `Err(e)`: widens `e` to the enclosing function's declared error union type and returns
early. Any linear values still owned in the current scope have their cleanup fired before
return. On `Ok(v)`: unwraps to `v` and continues.

---

## 6. Capabilities

```fit
// Declaring a capability requirement in a signature
fn serve(req: Request) using Net -> Result<Response, IoError>
fn charge(token: AuthToken) using Net, ChargeCard -> Result<Receipt, PaymentError>

// Projecting atoms from a bundle
select Read from Fs
select Read, Write from Fs

// Capabilities are always capitalized
// Atoms:   Read, Write, Net, Console, ...
// Bundles: Fs (= Read + Write + ...), ...
```

Strict resolution: exactly one capability of a given type must be in scope at a call site,
or it is a compile error. `select` produces the named atom(s) from the bundle — the bundle
is not consumed (capabilities are unrestricted unless explicitly linear).

---

## 7. Result and error handling

```fit
// Constructors
Ok(value)
Err(error)

// Type
Result<T, E>

// Named union alias (declared at module level)
type RequestError = ParseError | DbError | NetworkError

// Usage
fn handle(req: Request) using Net -> Result<Response, RequestError> {
    let parsed = parse(req)?        // ParseError widens to RequestError
    let row    = query(parsed)?     // DbError widens to RequestError
    Ok(build_response(row))
}
```

---

## 8. Early disposal

```fit
// drop is an ordinary consuming function whose body transfers nothing onward.
// Cleanup fires at this point, not at scope exit.
drop(conn)
```

`drop` is a built-in consuming sink. After `drop(conn)`, `conn` is unavailable. Any
resource can be passed to `drop` for explicit mid-scope cleanup. This is not a special
mechanism — it follows from the move/cleanup rules in §3 of the spec.

---

## 9. What is excluded from PoC syntax

The following are **out of scope** and must not be implemented or invented by the checker:

- Generics beyond a single typestate parameter `<S>` on resources
- Closures or first-class functions
- Modules, visibility modifiers, or package declarations
- Method-call sugar (`c.send(b)`)
- Async / concurrency constructs
- String interpolation or format macros
- Integer-tag enum variants (`Declined = 1`)
- Regions or cyclic structure syntax
- Two-phase cleanup (`fallback-preferred` warning) — reserved keyword only

---

## 10. Complete example — reference programs

These are the two canonical PoC test programs. The checker must accept both as valid.

### Payment authorization pipeline

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

    let token   = validate_card(card)?           // token: AuthToken (linear, owned)
    let receipt = execute_charge(token, amount)? // token consumed; cleaned inside on failure
    audit_log(receipt)?                          // receipt lent; still owned after
    Ok(receipt)
}
```

**Checker assertions:**
- `token` unavailable after `execute_charge` line.
- `receipt` still owned after `audit_log` (lend, not move).
- `validate_card` call site: `ChargeCard` not required, not passed.
- `execute_charge` call site: both `Net` and `ChargeCard` must be in scope.

### SMTP delivery session

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

// Lend: SmtpConn<Ready> not in return type — caller retains ownership
fn send_message(c: SmtpConn<Ready>, msg: Message) using Net
    -> Result<(), SessionError>

// Plain loop: c stays Ready throughout — no state crossing, no recursion needed
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

// Full session: straight-line setup → batch loop → straight-line teardown
fn run_session(host: String, creds: Credentials, msgs: List<Message>) using Net
    -> Result<(), SessionError> {

    let c = connect(host)?
    let c = greet(c)?
    let c = auth(c, creds)?
    let c = ready(c)?
    deliver_batch(c, msgs)?    // c lent for entire batch; still owned after
    let c = quit(c)?
    close(c)
}
```

**Checker assertions:**
- Each `let c = step(c)?` rebind: previous typestate unavailable after.
- `deliver_batch`: `c` lent — `SmtpConn<Ready>` still owned in `run_session` after the call.
- `run_session` error path: if `greet` fails, `SmtpConn<Fresh>` owned — auto-cleanup fires.
- Plain loop in `deliver_batch` typechecks — `c`'s state does not change in loop body.
- `close(c)` is a free function for graceful teardown, distinct from `tcp_force_close` cleanup.
```

*End of syntax reference.*
