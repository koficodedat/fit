# FIT — Settled Decisions + Full Integration Keyboard Test

> **Two purposes:**
> 1. **Consolidate** everything actually AGREED (not explored, not open) into one list.
> 2. **Test it as a set** — one realistic program using every settled decision together, to
>    see whether the decisions cohere or quietly contradict when combined.
>
> This supersedes scattered conclusions. Open forks are listed separately and explicitly.

================================================================================
## PART 1 — WHAT IS SETTLED (agreed, not just explored)
================================================================================

### Identity & scope
- **S1.** FIT targets systems → server → data. **Not** frontend. Not a constraint/logic
  language.
- **S2.** FIT is **functional-leaning**: types declare *data + (for resources) destruction*;
  **all behavior is free functions.** No methods, no inheritance, no dispatch, no `this`, no
  OO machinery.

### Memory & values
- **S3.** Three memory modes: **unrestricted** (default; use 0..∞, copyable), **affine**
  (use ≤1, droppable, **only if drop is a true no-op**), **linear** (use exactly once, must
  be disposed).
- **S4.** **Resource classification is forced by cleanup:** a type that declares cleanup has
  non-trivial drop → is a **resource** → is **linear**. No cleanup → plain data →
  unrestricted/affine. **affine + cleanup = compile error.** No "unrestricted resource"
  (logical contradiction).
- **S5.** **`mut` is a binding modifier**, not a memory mode: "rebind this name with the
  result" (consume old, bind new). Orthogonal to the 3 memory modes.

### Cleanup & disposal
- **S6.** **Automatic cleanup.** A resource's cleanup is declared once **at the type** and
  the compiler fires it on every scope exit where the value is still owned. Magic-free
  because the only thing that can fire is the type's own declared cleanup — a hidden
  call-*site*, never a hidden *choice*.
- **S7.** Cleanup **must be infallible** (cannot itself fail / must be total).
- **S8.** **`using` is NOT used for memory/resources.** It is reserved **only** for
  capability requirements. (Removes the old keyword overload.)
- **S9.** Ownership move-out (return/consume) means cleanup does **not** fire (no double-free).

### Borrowing
- **S10.** **Lend with no escape.** A function that uses-but-doesn't-consume a resource
  borrows it for the call's duration; the borrow **cannot escape** (not stored, returned, or
  captured to outlive the call). Because it can't escape, **there are no lifetimes to track**.
- **S11.** **No sigil.** Lend-vs-consume is **inferred from the signature** (consumed if the
  function takes ownership / returns nothing of it; lent otherwise). No `&`.

### Capabilities
- **S12.** Capabilities are **signature requirements** (`using Cap`), satisfied by context,
  resolved at compile time. **No ambient authority**; **import gives code, not authority**.
- **S13.** `main` declares its requirements; the **runtime** is the supplier/root. No `env`
  grab-bag.
- **S14.** **Strict resolution:** exactly one capability of a type per scope, else compile
  error. Different types coexist.
- **S15.** Two kinds: **authority-bearing** (root: runtime) and **permission** (root: a mint
  capability). **Unforgeable ≠ linear** (Console/Net are unforgeable-but-unrestricted).
- **S16.** Composition = **atoms + flat bundles + projection** (narrow to a subset). No
  lattice. (Open fork on membership auto-satisfy — see below.)

### Errors
- **S17.** Errors are **values** (sum types), no exceptions. A function's error type is the
  **union of its failure modes**, visible in the signature.
- **S18.** A failed **consuming** op returns its resource in the error (so it can be cleaned
  up). With automatic cleanup (S6), this is largely handled by the cleanup firing on the
  error exit.

### Typestate (KEPT — the differentiator)
- **S19.** **Typestate is core.** A resource's state can be encoded in its type
  (`Conn<Ready>`); operations illegal in a state don't exist → won't compile.
- **S20.** **Loop-across-transition requires recursion**, and the **compiler detects and
  demands it**: a loop whose body changes the binding's typestate fails to type-check
  (end-of-body type ≠ loop-head type), with an error telling the user to use recursion.
  Recursion is never silently required — it's compiler-demanded exactly when needed.
- **S21.** Straight-line transitions (handshakes) need **no** recursion — only
  loop-across-transition does (~15% of protocol code, per the frequency count).

================================================================================
## PART 2 — OPEN FORKS (explicitly NOT settled)
================================================================================
- **O1.** Capability bundle membership: does holding `Fs` auto-satisfy `using Read`, or must
  you `project` first? (leaning: project explicitly)
- **O2.** Error-union aggregation mechanism (named transparent unions; not yet tested).
- **O3.** Regions for cyclic/aliased linear structures: principle only; untested.
- **O4.** Async/concurrency: deferred entirely.
- **O5.** Type-system keywords (`record`/`data`/`struct`?, sum-type keyword) — next session.
- **O6.** Method-call *sugar* (`c.send(b)` for `send(c,b)`)? Deferred, cosmetic.
- **O7.** Cyclic resources / disposal-order-on-error-path: deferred until a real program needs.

================================================================================
## PART 3 — THE INTEGRATION KEYBOARD TEST
================================================================================
> A program using EVERY settled decision at once: a logging proxy that accepts a connection,
> performs a handshake (straight-line typestate), serves keep-alive requests (plain loop, no
> transition), drains on peer-close (loop-across-transition → recursion), writes each request
> to a log file (second resource, automatic cleanup), and is capability-gated throughout.
> Sigil-free borrow, no `using` for resources, functional style.

```fit
// ===== type declarations =====
resource Conn<S> {                          // S19 typestate; S4 resource->linear
    sock: Socket
    cleanup() { shutdown(sock) }            // S6 declared once; S7 infallible
}
resource LogFile {                          // S4 resource (no typestate needed here)
    fd: Fd
    cleanup() { close(fd) }
}
record Request { method: Str, path: Str }   // S2 plain data, no behavior; (O5: keyword tbd)
record Response { status: Int, body: Bytes }

enum RequestOutcome {                        // S17 sum type (O5: keyword tbd)
    Got(Request),
    PeerClosed,
    Timeout,
}

// ===== free functions; behavior lives here, not on types (S2) =====
// handshake: STRAIGHT-LINE typestate transitions (S21 - no recursion)
fn handshake(c: Conn<Fresh>) using Net      // S12 capability requirement
    -> Result<Conn<Ready>, HandshakeError> {  // S17 failure in signature
    let c = client_hello(c)?                 // Fresh -> Greeted ; S20 type changes, straight-line ok
    let c = server_ack(c)?                   // Greeted -> Ready
    Ok(c)                                    // S9 ownership moves out; cleanup won't fire
}

// read a request: LEND c (S10/S11 - not consumed, no sigil), state stays Ready
fn read_request(c: Conn<Ready>, log: LogFile) using Net    // c lent, log lent
    -> Result<RequestOutcome, IoError>

// serve keep-alive: PLAIN LOOP (S21 - Ready throughout, no transition)
fn serve(c: Conn<Ready>, log: LogFile) using Net, Fs       // S14 two diff capabilities coexist
    -> Result<Unit, IoError> {
    loop {                                                  // plain loop; c stays Conn<Ready>
        match read_request(c, log)? {                       // lend both; ? -> auto-cleanup on error (S6)
            Got(req) => {
                write_log(log, req)?                        // lend log
                let resp = route(req)                       // route is PURE - no `using` -> provably no I/O
                write_response(c, resp)?                    // lend c
            }
            PeerClosed => return drain(c, log),             // transition coming -> hand to recursive drainer
            Timeout    => return Ok(unit),                  // S6 c and log auto-cleanup here
        }
    }
}

// drain after peer FIN: LOOP-ACROSS-TRANSITION -> RECURSION (S20)
// (if this were written as a `loop`, the compiler would REJECT it: body would move
//  c from Conn<Ready> to Conn<Closing>, mismatching the loop head. S20 guardrail.)
fn drain(c: Conn<Ready>, log: LogFile) using Net, Fs -> Result<Unit, IoError> {
    match read_request(c, log)? {
        Got(req)   => { write_log(log, req)?; drain(c, log) }   // still Ready: recurse
        Timeout    => Ok(unit),
        PeerClosed => {
            let c = begin_close(c)?       // Conn<Ready> -> Conn<Closing> : TYPE CHANGES
            finish_close(c)               // consumes Conn<Closing>; done
            // log auto-cleanup fires on return (S6)
        }
    }
}

fn route(req: Request) -> Response { ... }   // PURE: no capability in signature => no I/O possible

// entrypoint: runtime supplies root capabilities (S13)
fn main() using Net, Fs -> Result<Unit, BindError> {
    let listener = bind(":8080")?
    loop {                                   // accept loop: each iteration's resources independent
        let c   = accept(listener)?          // Conn<Fresh>, owned
        let log = open_log("access.log")?    // LogFile, owned
        match handshake(c) {                 // c consumed by handshake
            Ok(ready) => serve(ready, log)?, // both flow in; auto-cleanup on any exit
            Err(e)    => log_error(log, e),  // c already disposed (consumed+failed, S18/S6); log used then auto-cleanup
        }
        // any owned resource still here auto-cleans (S6)
    }
}
```

================================================================================
## PART 4 — DOES IT COHERE? (the verdict)
================================================================================

### What held cleanly (the decisions reinforce each other)
1. **No-sigil borrow + automatic cleanup together kill ALL the old warts.** No `&`, no
   `using c = c`, no `release`, no manual close on the happy path. `serve` and `drain` read
   like ordinary code. **S6+S10+S11 compose into genuinely clean syntax.** This is the
   payoff of the whole session.
2. **Capabilities stay invisible until declared.** `route` has no capability → provably
   pure. `serve` needs `Net, Fs` → both in the signature, both coexist (S14). The audit
   surface is real and readable.
3. **Typestate + recursion guardrail (S20) works as designed.** `handshake` does
   straight-line transitions in a plain function (no recursion). `serve` loops because state
   doesn't change. `drain` recurses because it crosses Ready→Closing. The DIVISION IS
   VISIBLE AND PRINCIPLED — and the compiler enforces it (a loop in drain's place would be
   rejected).
4. **Two resources (Conn + LogFile) with independent automatic cleanup** — no ordering
   ceremony, each disposed on exit, no interaction. The old "two-body problem" is a non-issue
   under automatic cleanup.

### What's AWKWARD or UNCERTAIN (honest)
1. **INT-X1 — `Conn<S>` typestate + lend interaction.** `read_request(c: Conn<Ready>, ...)`
   lends `c`. Fine. But the moment a function must *transition* `c`, it must *consume* it
   (handshake, begin_close). So the rule "lend for use, consume for transition" is implicit
   in whether the signature shows a type change. **Is that inferable cleanly, or does the
   programmer get confused about when c is lent vs moved?** The signature *does* encode it
   (different return type = consumed), but a reader must look at the return type to know if
   an argument was consumed. **Mild concern: consume-vs-lend is inferred from the return
   type, which may not be locally obvious.** Needs a readability check with real users.
2. **INT-X2 — `match` arms returning vs falling through.** In `serve`, two arms `return` and
   one falls through to loop. The auto-cleanup must correctly fire for the `return` arms
   (disposing c+log) but NOT for the fall-through (still in use next iteration). This is
   sound under S6/S9 but is the subtlest cleanup reasoning in the program — the compiler must
   track per-arm ownership precisely. **Believed sound; flag for the implementation to prove.**
3. **INT-X3 — error in `handshake` consumed `c`; does `c` get cleaned up?** `handshake(c)`
   consumed `c`; on its internal `?`, the consuming op failed. Per S18, the failed op returns
   the resource in its error, and S6 cleans it. But in `main`'s `Err(e)` arm we only have
   `log`, not `c` — `c` is gone (cleaned inside handshake's failure). **This works only if
   handshake's failure path cleaned c internally.** Confirms S18+S6 must be airtight; the
   caller cannot clean what it no longer owns.

### Verdict
**The settled decisions COHERE.** One full program touched S2–S21 and the only issues found
are (a) a readability question about consume-vs-lend being inferred from return type
(INT-X1), and (b) two soundness obligations the compiler must honor precisely (INT-X2,
INT-X3) — not contradictions, but things an implementation must get right. **No settled
decision contradicted another.** The syntax is dramatically cleaner than any earlier round —
no sigils, no using-for-resources, no cleanup ceremony.

The single most important remaining readability risk is **INT-X1**: "you can't tell if a
function consumes or borrows its argument without reading its return type." That is the one
thing to watch in the PoC.
