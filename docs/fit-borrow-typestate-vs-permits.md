# FIT — Borrow (no-escape) × {Typestate-in-type vs. Position-4 Permits}

> **Setup, held constant across both:**
> - Borrow with no escape (`&T` = lend for the call, cannot be stored/returned/escape).
> - Existing cleanup mechanism only: `using x = ... cleanup f { }`. No new cleanup rule.
> - Same hard target: a TCP-style connection that **transitions state mid-loop** —
>   `Established`, then on a peer FIN enters `CloseWait`, must **keep looping to drain**
>   buffered data, then `Closing`. This is the exact case that produced the recursion
>   mandate in Test F. If either approach handles it with a plain loop and no cascade, that
>   approach works.
>
> **Two approaches tested:**
> - **A — Typestate in the type:** `Conn<S>`; the resource's type changes on transition.
> - **B — Position 4 permits:** `Conn` is ONE type; a separate linear permit token carries
>   the state; operations require the matching permit.
>
> **Question:** which (if either) gives compile-time ordering safety, with a plain loop,
> no recursion mandate, using only borrow + existing cleanup?

================================================================================
## APPROACH A — Typestate in the type, WITH borrow
================================================================================

```fit
resource Conn<S> { sock: Socket, cleanup: shutdown }   // type carries state S

fn recv(c: &Conn<Established>) -> Result<RecvOutcome, IoError>   // LEND, but typed by state
enum RecvOutcome {
    Data(Bytes),                         // still Established
    PeerClosed,                          // peer sent FIN -> we should be CloseWait now
}
fn drain(c: &Conn<CloseWait>) -> Result<DrainOutcome, IoError>
enum DrainOutcome { More(Bytes), Done }
```

### A.1 The wall, immediately
`recv` takes `&Conn<Established>`. On `PeerClosed`, the connection is *now* logically
`CloseWait`. But borrow LENT the conn — the owner still holds it as `Conn<Established>`.
**A lend cannot change the owner's type.** So after `recv` returns `PeerClosed`, the owner
still has a `Conn<Established>`, but reality says it's `CloseWait`. To get a
`Conn<CloseWait>` the owner must **transition the owned value's type** — which is a
*consuming* operation (consume `Conn<Established>`, produce `Conn<CloseWait>`), NOT a lend.

```fit
fn serve(mut c: Conn<Established>) using Net {     // must OWN c to change its type
    loop {
        match recv(&c)? {                          // lend to peek
            Data(b)    => handle(b),               // stays Established, fine
            PeerClosed => {
                // need: c : Conn<Established> -> Conn<CloseWait>. This CONSUMES c.
                let c2 = transition_to_closewait(c)   // c consumed; c2 : Conn<CloseWait>
                return drain_loop(c2)                 // DIFFERENT TYPE -> can't continue THIS loop
            }
        }
    }
}
```

**Finding A-1: borrow does NOT save typestate-in-the-type from the cascade.** The moment the
state change must be *observed by the owner* (not just used within a call), the owner's value
must change type, which is a consuming transition, which **cannot happen inside a loop whose
binding is typed `Conn<Established>`**. You're forced to exit the loop and call into a new
loop typed for the new state — i.e. **recursion / loop-splitting returns.** Borrow helped
where the type *didn't* change (the `Data` arm) but is powerless where it *does* (the
`PeerClosed` arm). **The cascade survives in Approach A.** Typestate-in-the-type is
fundamentally incompatible with a single plain loop across a transition, borrow or not.

### A.2 Verdict A
Compile-time safety: **YES** (can't call `drain` on an `Established` conn). Plain loop across
transition: **NO** — recursion/loop-split mandate returns. Borrow mitigates only the
non-transition operations. **Approach A still carries the baggage.**

================================================================================
## APPROACH B — Position 4 permits, WITH borrow
================================================================================

```fit
resource Conn { sock: Socket, cleanup: shutdown }   // ONE type, NEVER changes

// State lives in linear PERMIT tokens, not in Conn's type.
resource EstablishedPermit { cleanup: noop }        // linear marker; holding it = "Established"
resource CloseWaitPermit    { cleanup: noop }

// ops LEND the conn (no escape) and CONSUME/PRODUCE permits to enforce ordering
fn recv(c: &Conn, p: EstablishedPermit)
    -> Result<(RecvOutcome, EstablishedPermit | CloseWaitPermit), IoError>
//   you must HOLD an EstablishedPermit to call recv. On PeerClosed it returns a
//   CloseWaitPermit instead -> your permit changes, the CONN does not.

fn drain(c: &Conn, p: &CloseWaitPermit) -> Result<DrainOutcome, IoError>   // lend permit too
```

### B.1 The same loop
```fit
fn serve(c: &Conn, mut perm: EstablishedPermit) using Net {   // LEND conn; OWN the permit
    loop {
        match recv(c, perm)? {                     // consume perm, get one back
            (Data(b), Established(p))  => { handle(b); perm = p }    // rebind SAME-typed permit
            (PeerClosed, CloseWait(p)) => {
                // conn type unchanged (still &Conn). permit is now CloseWaitPermit.
                return drain_phase(c, p)           // hand off to drain — but see B.2
            }
        }
    }
}
```

### B.2 The honest problem — permits DON'T actually avoid the loop split either
Look at the `PeerClosed` arm: `perm` is now a `CloseWaitPermit`, a *different type* than the
loop's `mut perm: EstablishedPermit`. **`mut` can't rebind across permit types any more than
it could across conn types.** So we STILL can't continue the same loop — we hand off to
`drain_phase`. **The type-change problem just moved from the conn to the permit.** B-1:
**permits relocate the cascade, they don't remove it**, *if* the permit's type encodes the
state.

### B.3 The fix that actually works — permit state as DATA, not type
What if the permit is ONE type and the state is a *value* inside it (or the outcome is a
plain enum), and the "ordering guarantee" is enforced by **requiring the permit to call the
op at all**, not by the permit's type?

```fit
resource Permit { cleanup: noop }                  // ONE permit type. holding it = "may operate"

fn recv(c: &Conn, p: &Permit) -> Result<RecvOutcome, IoError>   // lend conn AND permit
enum RecvOutcome { Data(Bytes), PeerClosed }
fn drain(c: &Conn, p: &Permit) -> Result<DrainOutcome, IoError>

fn serve(c: &Conn, p: Permit) using Net {          // own ONE permit, never changes type
    let mut phase = Phase::Established              // state as DATA (unrestricted enum)
    loop {
        match phase {
            Established => match recv(c, &p)? {      // lend conn + permit
                Data(b)    => handle(b),
                PeerClosed => phase = CloseWait,     // just reassign DATA. no type change!
            },
            CloseWait => match drain(c, &p)? {
                More(b) => handle(b),
                Done    => break,
            },
        }
    }
}                                                   // p dropped (noop), conn returned to owner
```

**Finding B-2: this works — plain loop, mid-loop transition, no recursion, no type change.**
`phase` is unrestricted DATA reassigned freely; `Conn` is lent; `Permit` is lent. Nothing's
type changes, so `mut`/loop is fine. **The cascade is genuinely gone.**

### B.4 But what did we give up?
Compare what each guarantees:
- **Holding a `Permit` is required to call `recv`/`drain`** — so a function with no permit
  provably cannot operate the connection. That guarantee **survives** (it's just a linear
  capability gate — FIT's existing strength).
- **Calling `drain` while in `Established` phase** — is this prevented at compile time? **NO.**
  `phase` is runtime data; nothing stops `match phase { Established => drain(...) }` if you
  wrote the wrong arm. The state-*ordering* guarantee is now **runtime-checked, not
  compile-enforced.** We're back to Position 2 (Option 1) for *ordering*, while keeping
  compile-time *authority* (the permit gate).

### B.5 Verdict B
- One-type-permit (B.3): plain loop across transition **YES**, no cascade **YES**, but
  state-ordering is **runtime-checked** (only authority is compile-checked).
- Typed-permit (B.2): compile-checked ordering **YES**, but cascade **returns** (permit type
  changes). **Same wall as Approach A.**

================================================================================
## THE RESULT
================================================================================

**There is a hard tradeoff, and it's now precisely located. Pick at most two of three:**

| | Compile-time ordering safety | Plain loop across transitions (no cascade) | One simple mechanism |
|---|---|---|---|
| **A: typestate-in-type** | ✓ | ✗ (recursion mandate returns) | ✓ |
| **B-typed-permit** | ✓ | ✗ (cascade moves to permit) | ✗ (two things to thread) |
| **B-data-phase** | ✗ (ordering is runtime) | ✓ | ✓ |
| **Option 1 (demoted)** | ✗ | ✓ | ✓ |

**The core finding:** *compile-time enforcement of state ORDERING* and *a plain loop across a
state transition* appear to be **fundamentally in tension**, and borrow does NOT resolve it —
because any mechanism that makes "wrong-order = won't compile" must encode the state in a
*type*, and any type that changes on transition breaks `mut`-in-a-loop. **This is not a FIT
wart; it is intrinsic.** It's why session-typed languages use recursion, and why mainstream
languages check protocol state at runtime.

**What borrow DID buy (real, keep it):** it cleanly removed the *threading/ownership*
verbosity and the `using x = x` wart for all the operations that DON'T change state (the
common case). That's a genuine ergonomic win independent of this tradeoff.

**What this means for the typestate-as-core dream:** it cannot be restored "as it was"
without the cascade. The cascade is the *price* of compile-time ordering safety, intrinsically.
So the real choice for FIT is a values choice:

1. **Compile-time ordering safety is worth the recursion idiom** → embrace typestate +
   recursion for protocols, accept it's the one place loops don't apply, teach it explicitly.
   FIT becomes "the language that makes protocol misuse a compile error, at the cost of
   recursion-for-state." That IS a differentiator vs. Austral (which doesn't enforce ordering).
2. **Plain loops everywhere matter more** → state ordering is runtime/test-checked (like
   everyone else); FIT keeps compile-time *authority* (permits/capabilities) but not *ordering*.
   This is Option 1 / largely-Austral.

**Borrow + permits did NOT find a free lunch. It proved the lunch isn't free** — and located
the bill precisely. That's a real result: the earlier rounds kept *hoping* the tension was an
artifact; this test shows it's intrinsic, so the decision is now an honest values fork, not a
design bug to engineer away.

================================================================================
## Recommendation for the decision (not made here)
================================================================================
The differentiator-vs-Austral question now has a crisp answer: **FIT is distinct from Austral
*only* if it takes path 1** (compile-time ordering safety via typestate+recursion). Path 2 is
Austral. So "is FIT worth being its own language" reduces to "is compile-time protocol-ordering
safety worth mandating recursion for state machines, as a deliberate, taught tradeoff?"

That is finally a clean, decidable question — and it's the one to sit with.
