# FIT — Two Falsification Tests: `mut` on Linear Values, and Disposal Order

> **Purpose:** two small, real tests aimed at breaking specific claims.
> **Test A:** `mut` was defined as "consume-and-rebind" sugar — does that survive when the
> rebound value is itself **linear** (not unrestricted like `stats`)?
> **Test B:** flat `using` disposes LIFO — does that break when a real program needs a
> disposal order that is **not** the reverse of acquisition?
>
> Both are drafted to falsify, not to confirm. A clean pass and a clean break are equally
> valuable findings.

---

## PART 1 — Background the tests will pin down: the four "use modes"

These four are currently under-specified and the tests below exist to expose how they
actually interact. Stating the working definitions so the tests have something to break:

| Mode          | Rule                                              | Disposal? | Copyable? |
|---------------|---------------------------------------------------|-----------|-----------|
| **unrestricted** | use any number of times (incl. zero)           | none      | yes       |
| **affine**    | use **at most once** (zero or one); may be dropped | drop-ok  | no        |
| **linear**    | use **exactly once**; may NOT be silently dropped | required | no        |
| **mut**       | a *binding* modifier, not a 4th memory mode: "this name is rebound with each result" | — | — |

Key claim under test: **`mut` is orthogonal to the other three.** It modifies a *binding*
(a name), while unrestricted/affine/linear classify a *value*. If that orthogonality holds,
`mut linear`, `mut affine`, `mut unrestricted` should all be meaningful and consistent. If
it doesn't, `mut` is secretly a memory mode and the model is wrong.

---

## TEST A — `mut` on a linear value

### A.1 The control case (already claimed to work): `mut` on unrestricted
```fit
let mut stats = Stats::zero()       // unrestricted
loop {
    stats = stats.count()           // consume old stats, bind new; name persists
}
```
Claimed semantics: each step consumes the old value once and rebinds. For an
**unrestricted** value this is trivially fine (it could be used any number of times anyway;
single-use-then-rebind is just a special case). So `mut unrestricted` is consistent — but
it's the *easy* cell, and proves little. The real test is linear.

### A.2 The real test: `mut` on a linear resource that transitions (typestate)
A connection we send on repeatedly. The connection is **linear** (one live copy, must be
closed). Each `send` consumes it and returns it advanced. Does `mut` express the loop
cleanly?

```fit
fn stream_all(items: List<Bytes>, c: Connection<Ready>)
    -> Result<Connection<Ready>, (SendError, Connection<Failed>)> {
    let mut conn = c                       // mut binding over a LINEAR value
    for item in items {
        conn = send(conn, item)?           // consume conn (linear, once), rebind same name
    }                                      // each iteration: exactly-once use satisfied
    conn                                   // thread the live connection back out
}
```

**Walk it against the rules:**
- `conn` is linear → must be used exactly once per value. `send(conn, item)` consumes it
  (one use ✓), produces a new `Connection<Ready>`, rebinds `conn`. The *old* value was used
  exactly once; the *new* value is now the live one. Linearity satisfied **per value**.
- `mut` here means exactly what it meant for `stats`: rebind the name with the result. The
  fact that the value is linear changes **nothing** about `mut` — it changes only that the
  rebind is *mandatory* (you couldn't drop the old `conn`; you had to consume it, which the
  `send` did).

**Finding: `mut` on linear HOLDS, and the orthogonality claim survives.** `mut` is
genuinely a binding modifier, not a memory mode. The difference between `mut stats` and
`mut conn` is entirely carried by the *value's* mode (unrestricted vs linear), not by
`mut`. This is the cleanest possible outcome: `mut` × {unrestricted, affine, linear} are
all just "rebind the name," and the value's mode independently governs use-count.

### A.3 The genuine subtlety the test exposes — early exit from the loop
What if `send` **fails** mid-loop?
```fit
        conn = send(conn, item)?     // on SendError: returns (SendError, Connection<Failed>)
```
On `?`, we leave `stream_all` early. But `conn` is linear and live — the propagation rule
(§4.3) says we cannot leave holding an undisposed linear value. There is **no `using …
cleanup` here** — `conn` was passed in, not acquired. So who disposes the `Connection<Failed>`?

This is the SAME shape as the original handshake hole, and the resolution from the
twobody-test applies: **a linear value passed in as an argument must be owned by a `using`
binding in the *caller*.** `stream_all` doesn't own `c`'s cleanup — its caller does. So on
`?`, the `Connection<Failed>` must be **threaded into the error and returned** (which the
signature already does: `(SendError, Connection<Failed>)`), and the caller's `using`
disposes it.

But notice the wrinkle `mut` adds: the value being threaded out on error is the **current
binding** of `conn`, which `mut` has been rebinding. So the `?` desugaring must thread *the
current value of the mut binding* into the error, not the original `c`. **This needs to be
an explicit rule:** `?` inside a function holding a `mut` linear binding threads *the
binding's current value* into the error path. Stated, it's clean; unstated, it's a
latent bug. **This is the one new rule Test A surfaces.**

### A.4 Test A verdict
- `mut` × linear **HOLDS**; orthogonality of `mut` confirmed (it's a binding modifier).
- The 4-mode table stands: unrestricted/affine/linear classify values; `mut` classifies
  bindings; they compose freely.
- **One new rule required:** `?` must thread the *current* value of a `mut` linear binding
  into the error path. (Add to the error model.)
- **Affine note:** `mut affine` also works and is actually *easier* — an affine value MAY
  be dropped, so a `mut affine` binding whose value is never rebound again can just be
  dropped at scope exit with no error. Affine is the "relief valve" between linear (must
  consume) and unrestricted (ignore freely).

---

## TEST B — disposal order ≠ acquisition order (the Unix pipe)

### B.1 The setup that should break LIFO
A pipe connecting a producer and consumer. Correct teardown **requires** closing the
**write** end first, so the reader sees EOF and drains; closing read-end-first (or LIFO)
can deadlock the writer or lose buffered data. Acquisition order is read-end then
write-end (or vice versa); the *required* disposal order is write-end-first regardless.

```fit
using read_end  = pipe_read(p)?   cleanup close,
      write_end = pipe_write(p)?  cleanup close
{
    spawn_writer(write_end)        // (conceptually) fills the pipe
    drain(read_end)?
    unit
}
// flat using disposes LIFO: write_end first, THEN read_end.
```

### B.2 The surprise: LIFO actually gives the RIGHT order here
Acquisition: `read_end` then `write_end`. LIFO disposal: `write_end` then `read_end` —
**which is exactly the required order** (close write end first so reader drains). So in
*this* arrangement, LIFO is correct by luck of acquisition order.

### B.3 Forcing the real break — when you CAN'T reorder acquisition
The break only appears when the *required* disposal order conflicts with an acquisition
order you don't control — e.g. resources handed to you already-acquired, in an order fixed
by someone else:

```fit
fn relay(read_end: PipeRead, write_end: PipeWrite) using Net {
    // both passed in; acquisition order is NOT ours to choose.
    // suppose the protocol REQUIRES: close read_end first, then write_end.
    // but caller's using acquired write_end last -> LIFO would close write_end first. WRONG.
}
```
Here LIFO (a property of the *caller's* acquisition order) may not match the *callee's*
required disposal order. **This is a real break: flat `using` LIFO cannot express a
disposal order decoupled from acquisition order.**

### B.4 The fix — and whether it needs new machinery
Option 1 (no new machinery): **explicit disposal in the body before scope exit.** Close in
the required order manually; the `using cleanup` only fires for whatever's *still owned* at
exit (the §6.1 move-vs-cleanup rule from the twobody-test):
```fit
using ... {
    ...
    close(read_end)        // explicit, in required order; read_end now no longer owned
    close(write_end)       // explicit
    // scope exit: nothing left owned, no cleanup double-fires
}
```
This **works with rules we already have** — explicit consume removes the value from the
`using`'s cleanup obligation. The cost: you write the closes by hand in the rare case where
order matters, and you lose the safety of automatic cleanup *if an error fires between the
two manual closes*. That last point is the real residue:

### B.5 The genuine residue Test B exposes
If an error occurs **between** `close(read_end)` and `close(write_end)`, then `read_end` is
already closed (fine) but `write_end` is still owned → its `cleanup` fires on the error
exit. Good — *unless* the required error-path order also matters. Manual ordered close +
automatic cleanup of the remainder is **sound for disposal completeness** (nothing leaks)
but does **not** guarantee *ordered* disposal on the error path.

**Verdict B:** LIFO covers the common case (often by acquisition-order luck). The true break
(disposal order decoupled from acquisition, especially across function boundaries) is real
but **rare**, and is handled by *explicit ordered close* using existing rules — at the cost
of ordered-disposal-on-error guarantees. **No new primitive is justified yet.** A dedicated
"ordered cleanup" feature would only pay for itself if a real program needs *guaranteed
ordered disposal even when an error interrupts the ordering* — which we have not yet found.
So this one genuinely *does* wait for a real program — but now we've shown *why*, with a
concrete example, instead of asserting it.

---

## Summary of findings

**Test A — `mut` × memory modes:**
- `mut` is confirmed **orthogonal**: a binding modifier ("rebind name with result"), not a
  4th memory mode. Composes with unrestricted/affine/linear freely.
- The four-mode model (unrestricted / affine / linear / mut-as-binding) is **consistent**
  and should be documented as a matrix: value-mode (3) × binding-mode (mut or not).
- **New rule required:** `?` threads the *current* value of a `mut` linear binding into the
  error path.
- Affine is the ergonomic middle: may-drop, so `mut affine` needs no mandatory rebind.

**Test B — disposal order:**
- LIFO is correct for the common case.
- Decoupled disposal order (esp. across function boundaries) is a real break, handled by
  explicit ordered close via existing rules.
- A dedicated ordered-cleanup primitive is **not** justified until a program needs
  guaranteed *ordered* disposal *on the error path*. This is the one place "wait for a real
  program" is now earned, not lazy — the example shows the exact unmet condition.

**Net:** the value/binding model survived with **one** added rule (mut-linear `?`
threading) and **zero** new primitives. The disposal-order question is bounded and its open
case is precisely characterized. Documentation must now formalize the
unrestricted/affine/linear/mut interaction matrix — it is consistent, but it is the densest
part of FIT and the easiest to get subtly wrong.
