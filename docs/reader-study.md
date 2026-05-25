# FIT Reader Study

**PoC question 2:** Are the canonical programs readable by a non-programmer?

This document is the instrument for that study. It presents both canonical programs
with enough orientation for a reader who has never seen FIT before, followed by
comprehension questions to be answered after reading.

---

## Reading FIT: five things to know

### 1. Resources — things the program takes responsibility for

```
resource AuthToken {
    token_id: TokenId,
    cleanup:  void_token,
}
```

A **resource** is anything that requires careful handling: a payment authorisation,
a network connection, a database session. Every resource has a declared **cleanup**
action — what happens automatically if the program exits before the resource is
explicitly used up. For `AuthToken`, the cleanup is `void_token`: if anything goes
wrong, the token is voided before the function returns.

The language guarantees:
- Every resource is handled **exactly once** — it cannot be abandoned or used twice.
- If an error occurs mid-function, cleanup fires automatically before returning.

---

### 2. Typestate — tracking what stage a resource is in

```
resource SmtpConn<S> { ... }   -- S is the current stage
```

An `SmtpConn` can be in different **stages**: `Fresh`, `Greeted`, `Authed`, `Ready`,
or `Closing`. The language tracks the current stage and refuses to compile code that
skips steps — you cannot send a message on a `Fresh` connection; you must greet and
authenticate first. The stage is part of the type, so the compiler catches the
mistake before the program ever runs.

---

### 3. Consuming vs. borrowing — who is responsible after the call?

```
fn execute_charge(token: AuthToken, amount: Cents) -> ...
```

When a function takes a resource, the language figures out automatically whether
it **borrows** the resource (uses it and gives it back to the caller) or
**consumes** it (takes full ownership, after which the caller cannot use it again).

`execute_charge` consumes `token` — after calling it, `token` is gone. You cannot
charge the same authorisation token twice; the language makes that impossible.

`send_message`, by contrast, borrows the connection — after calling it, the caller
still owns the connection and can send another message.

---

### 4. Capabilities — declared permissions for sensitive operations

```
fn execute_charge(token: AuthToken, amount: Cents) using Net, ChargeCard
    -> Result<Receipt, PaymentError>
```

The `using Net, ChargeCard` clause lists what **capabilities** this function needs.
`Net` means network access; `ChargeCard` means permission to charge a payment card.
A function that does not declare `using ChargeCard` cannot charge cards — the
language prevents it. Sensitive permissions are visible at every call site and
verified by the compiler.

---

### 5. `?` — propagate failure, clean up automatically

```
let token = validate_card(card)?
```

The `?` means: "if `validate_card` returns an error, stop here, clean up any open
resources that this function owns, and return the error to my caller." If it
succeeds, `token` holds the result and execution continues to the next line.

This is FIT's safety net: you cannot forget to handle a failure, and you cannot
leak a resource when a failure occurs. The language handles both automatically.

---

## Program 1 — Payment processing

### Source

```
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

### Walkthrough

**Lines 1:** Declares that `ChargeCard` is a permission that must be explicitly granted
to any function that wants to charge a card. No function can charge a card unless it
declares `using ChargeCard`.

**Lines 3–6:** An `AuthToken` is a short-lived authorisation returned by the card
network after validation. It has a cleanup action: if the program exits before the
token is used, it is automatically voided (to prevent replay attacks).

**Line 8:** The four ways a payment attempt can fail.

**Lines 10–17:** Three operations, each declared with its network and permission
requirements and its possible outcomes. None of them have bodies here — they are
provided by external libraries. The signatures alone tell us what they need and
what they produce.

**Lines 19–26:** The only function with a body — the one that orchestrates the
payment:

1. `validate_card(card)?` — Ask the card network to validate the card details.
   If validation fails (declined, invalid card, network error), stop here and
   return the error. If it succeeds, bind the authorisation token to `token`.

2. `execute_charge(token, amount)?` — Use the token to charge the given amount.
   This **consumes** `token` — it cannot be used again after this line. If the
   charge fails, stop here and return the error (the token has already been
   consumed by the attempt; the language knows this). If it succeeds, bind the
   receipt to `receipt`.

3. `audit_log(receipt)?` — Record the receipt. If logging fails, propagate the
   error. The receipt itself is plain data, not a resource, so it is not
   consumed by this call.

4. `Ok(receipt)` — Return the receipt to the caller, wrapped in `Ok` to signal
   success.

### Things the language guarantees for this program

- The token cannot be charged twice — `execute_charge` consumes it.
- If the charge succeeds but logging fails, the receipt is still returned to the
  caller; the error from `audit_log` is propagated but the charge is not reversed
  (that is a business decision the program explicitly encodes by returning `Ok(receipt)`
  before checking the log result — note the order).
- `process_payment` cannot be called by a function that does not hold `ChargeCard`.
- If validation or charging throws an unexpected error, any still-open resources
  are cleaned up before the function returns.

---

## Program 2 — SMTP email session

### Source

```
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

### Walkthrough

**Line 1:** The five stages an SMTP connection moves through, in order. The language
enforces this order: you cannot call `auth` on a `Fresh` connection; you must `greet`
first.

**Lines 3–6:** An `SmtpConn` holds a TCP socket. The `<S>` marks the current stage.
The cleanup is `tcp_force_close`: if anything goes wrong, the socket is force-closed
before returning.

**Lines 8–9:** Two error categories. `SessionError` is either an SMTP-level error or
a lower-level I/O error.

**Lines 11–17:** The six steps of an SMTP session, declared as a progression. Each
function takes the connection in one stage and — if successful — returns it in the
next. The compiler uses this to verify that the steps are performed in order and
that no step is skipped.

- `connect` produces a `Fresh` connection.
- `greet` takes `Fresh`, produces `Greeted`.
- `auth` takes `Greeted`, produces `Authed`.
- `ready` takes `Authed`, produces `Ready`.
- `quit` takes `Ready`, produces `Closing`.
- `close` takes `Closing`, produces nothing (the connection is gone).

**Lines 19–21:** `send_message` **borrows** the connection — it does not consume it.
After calling it, the caller still holds the `Ready` connection. This is why the
same connection can be used to send many messages in a loop.

**Lines 23–37 — `deliver_batch`:** Sends a list of messages over a ready connection.

- `let mut remaining = msgs` — the message list is tracked as it is consumed.
- The `loop` repeats until explicitly broken.
- `match next(remaining)` — pull the next message from the list. Two outcomes:
  - `None` — the list is empty; exit the loop.
  - `Some(msg, rest)` — there is a message (`msg`) and the remaining list (`rest`).
    Send the message. If sending fails, propagate the error. Otherwise, advance
    `remaining` to the rest of the list.
- `Ok(())` — all messages sent; return success.

The language verifies that the loop does not change the connection's stage — a
loop that accidentally moved a `Ready` connection to `Closing` mid-batch would be
a compile error.

**Lines 39–50 — `run_session`:** The full sequence: set up the connection, deliver
the messages, tear it down.

Each step passes the connection forward. Using `let c = ...` for each step may look
like the same variable is being reused, but the language sees them as distinct: the
old `c` is consumed by the call on the right, and a new `c` (in the next stage) is
bound on the left. Writing `greet(c)?` after `let c = greet(c)?` would be a
compile error — the first `c` no longer exists.

### Things the language guarantees for this program

- The steps happen in order: connect → greet → authenticate → send → quit → close.
  Calling them out of order is a compile error.
- The connection is always cleaned up: if any step fails, the TCP socket is
  force-closed before the function returns.
- `send_message` can be called many times without consuming the connection, because
  the language verified it only borrows.
- The loop cannot accidentally change the connection's stage — the compiler checks
  the loop body leaves the connection in the same state it found it.

---

## Study questions

These questions are to be answered after reading the programs above — without
referring to any other documentation.

### Payment processing

1. What are the three steps that happen inside `process_payment`, in order?

2. After `validate_card` succeeds, what does the program hold that it did not
   have before?

3. What happens to `token` after `execute_charge` is called?
   Can it be used again?

4. What would happen if the network went down between `execute_charge` and
   `audit_log`? Would the charge still go through?

5. Could a function without `using ChargeCard` in its signature call
   `execute_charge`? What would stop it?

6. What does the `?` after `validate_card(card)` do if the card is declined?

### SMTP session

7. List the five stages the SMTP connection passes through, in order.

8. Why can `send_message` be called in a loop without the connection being
   used up?

9. What would happen if you tried to call `auth` on a connection that had
   already been greeted and authenticated?

10. In `run_session`, `c` is reused as the name for the connection at every
    step. After `let c = greet(c)?`, can the original `c` (the `Fresh`
    connection) be used again?

11. What does the language do with the TCP socket if `auth` returns an error?

12. In `deliver_batch`, what does `match next(remaining)` do? What are the
    two things that can happen?

---

*End of reader study instrument.*
