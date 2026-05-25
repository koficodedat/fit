# FIT — Three Falsification Tests: Illegal Transitions, Affine Cells, R4 Generality

> **Method, unchanged:** pick a finished/real target, write it by hand, try to break the
> claim. A clean break is as valuable as a clean pass.
>
> - **Test C** — typestate "illegal transition won't compile" against **TCP** (RFC 793, a
>   frozen, real, published state machine FIT did not design).
> - **Test D** — the **affine** cells of the matrix (affine×plain, affine×mut), unverified
>   until now.
> - **Test E** — **R4** ("`?` threads the current value of a `mut` linear binding") beyond
>   the single loop shape it was first seen in.

---

## TEST C — illegal transitions vs. the real TCP state machine

### C.1 Why TCP is the honest target
TCP's state machine is published (RFC 793), frozen for decades, and FIT had no hand in
designing it. If FIT's typestate can encode it *and* make illegal transitions fail to
compile, the claim survives against a spec we can't tilt. TCP is also nastier than a
handshake: it has **branching** transitions, transitions driven by **remote events** (not
just local calls), and **simultaneous-close** races. Good adversary.

### C.2 The states (RFC 793)
`CLOSED → LISTEN → SYN_RCVD → ESTABLISHED → CLOSE_WAIT → LAST_ACK → CLOSED`
and the active-open path
`CLOSED → SYN_SENT → ESTABLISHED → FIN_WAIT_1 → FIN_WAIT_2 → TIME_WAIT → CLOSED`.

### C.3 Encoding the local-call transitions (the part that works)
```fit
resource Tcp<S>

fn connect(s: Tcp<Closed>)   using Net -> Result<Tcp<SynSent>, ConnError>
fn send(s: Tcp<Established>, b: Bytes) -> Result<Tcp<Established>, SendError>
fn close(s: Tcp<Established>)          -> Tcp<FinWait1>
fn recv(s: Tcp<Established>) -> Result<(Bytes, Tcp<Established>), RecvError>
```

The 5-second demo holds, same as before:
```fit
send(tcp, data)?     // where tcp : Tcp<SynSent>
//  COMPILE ERROR: send requires Tcp<Established>; tcp is Tcp<SynSent>.
```
Calling `send` before the connection is established does not compile. **Local-call illegal
transitions: caught.** Good — but this is the easy half, the same shape we already proved.

### C.4 BREAK #C1 — transitions driven by REMOTE events, not local calls
TCP changes state because of packets that *arrive*, not only because of functions you call.
In `ESTABLISHED`, the **peer** can send a FIN, moving you to `CLOSE_WAIT` — you did not call
anything. Your next `recv` must return "peer closed," and the connection's type must now be
`Tcp<CloseWait>`, not `Tcp<Established>`.

But a function signature like `recv(s: Tcp<Established>) -> (Bytes, Tcp<Established>)`
**cannot** express "you went in Established and might come out CloseWait." The state change
is **data-dependent on a runtime event**. Typestate is a *compile-time* discipline; it
cannot know at compile time whether a FIN arrived. So `recv` must return a **sum over
possible next states**:

```fit
fn recv(s: Tcp<Established>)
    -> Result<RecvOutcome, RecvError>

enum RecvOutcome {
    Data(Bytes, Tcp<Established>),     // still established
    PeerClosed(Tcp<CloseWait>),        // peer sent FIN -> we are now CloseWait
}
```
**Finding:** typestate alone cannot model event-driven transitions; it must be paired with
a **runtime sum type whose variants carry the different next-state types.** This is not a
break of the *guarantee* (illegal transitions still can't compile — you must `match` and
handle the `CloseWait` arm before you can call anything), but it **is** a break of the
implicit claim that transitions are expressed purely by call signatures. The honest model:
**typestate handles *which operations are legal in a state*; event-driven state changes are
expressed as sum types over states that the caller must `match`.** The two compose, but the
second was not in our model and must be added.

### C.5 BREAK #C2 — simultaneous close (the race)
In TCP, both sides can send FIN at once: `FIN_WAIT_1 → CLOSING → TIME_WAIT`. This means from
`FIN_WAIT_1` there are **two** legal next states depending on what the peer does
(`FIN_WAIT_2` if only your FIN was acked; `CLOSING` if a simultaneous FIN arrived). Same
resolution as C1 — a sum type over `{FinWait2, Closing}` — so it doesn't break the model
*again*, but it confirms C1's finding is **pervasive in real protocols**, not a corner case.
Branching, event-driven transitions are the norm, not the exception.

### C.6 Verdict C
- Illegal **local-call** transitions: **caught at compile time. PASS.**
- **Event-driven / branching** transitions: typestate alone is **insufficient**; the model
  needs an explicit companion rule — *transitions whose outcome depends on remote events or
  races are returned as sum types over the possible next-state types, and the caller must
  `match` to obtain a usable typed handle.* The exactly-once-and-legal guarantee survives
  (you can't skip the match; you can't use a wrong-state handle), but **our description was
  incomplete** and must be extended. **PARTIAL — guarantee holds, model description was
  missing a major piece.**

This is the most important finding of the session so far: real protocols are
**event-driven**, and a call-signature-only view of typestate quietly assumed they were
**call-driven**. The fix (sum-over-next-states) is not new machinery — FIT already has sum
types — but the *combination rule* is new and load-bearing.

---

## TEST D — the affine cells (affine×plain, affine×plain)

### D.1 affine × plain — the optional lease
Affine = use at most once; may be dropped. Real case: a **try-lock** that may or may not be
acquired, and if acquired may or may not be used.

```fit
fn maybe_fast_path(data: Data) using Cache -> Result<Output, Error> {
    let lease: affine CacheLease = try_lock_cache()    // may succeed; affine handle
    // path 1: use it
    if should_cache(data) {
        let out = with_lease(lease, data)?   // consumes the lease (its one allowed use)
        return Ok(out)
    }
    // path 2: DON'T use it — affine allows the drop, no cleanup, no error
    Ok(slow_path(data))                       // lease silently dropped here. LEGAL (affine).
}
```
**Walk it:** on path 2, `lease` is never used. For a **linear** value this is a compile
error (must be consumed). For **affine**, dropping is legal — *provided dropping is truly a
no-op.* That proviso is the catch:

### D.2 BREAK #D1 — affine is only sound if the drop is genuinely free
A `CacheLease` that, when dropped, leaves a lock **held** is a bug — affine let you drop it,
but the lock leaked. So **affine is only correct for things whose abandonment costs
nothing.** A lock, a file, a socket — these are **linear**, not affine, precisely because
dropping them leaks a real resource. Affine is for values where "forgot about it" is
*semantically harmless*: an optional token, a memoization hint, a speculative reservation
that the system reclaims on its own.

**Finding:** the matrix needs a sharper rule than "affine = may drop." It is: **affine is
legal only when the type's drop is observationally a no-op.** If drop must *do* something
(release, close, zeroize), the type must be **linear** with a `cleanup`, not affine.
Otherwise affine becomes a silent-leak hatch. **D1 is a real sharpening — the prior
definition was unsafe as written.**

### D.3 affine × mut
```fit
let mut hint: affine Hint = initial_hint
loop {
    hint = refine(hint)        // consume old (its one use), rebind new
    if good_enough(hint) { break }
}
// after the loop, hint may be used once more, or dropped (affine). Both legal.
```
**Holds**, and is *easier* than linear×mut: because affine may be dropped, there is **no R4
obligation** to thread the current value into an error path — on early exit, an affine
`mut` binding can simply be dropped (if its drop is a no-op, per D1). So R4 is a
**linear-only** rule; affine bindings are exempt. This is a clean, useful asymmetry.

### D.4 Verdict D
- affine×plain and affine×mut **HOLD**, but only under the **sharpened rule (D1):** affine
  is sound *only* when drop is a true no-op. Anything with a real disposal cost must be
  linear. The matrix doc's "affine = relief valve" is correct but was **dangerously
  underspecified**; D1 is the guardrail.
- Bonus: affine bindings are **exempt from R4** (no current-value-threading duty), because
  they may be dropped on early exit. Asymmetry confirmed and useful.

---

## TEST E — R4 generality beyond the single loop

R4: "`?` threads the *current* value of a `mut` linear binding into the error path." First
seen in a simple `for` loop. Try to break it in three harder shapes.

### E.1 Nested mut linear bindings + `?`
```fit
fn pump(mut a: Conn<Ready>, items: List<Bytes>) using Net
    -> Result<(Conn<Ready>), (PumpError, Conn<Failed>, Conn<Failed>)> {
    let mut b = open_secondary()?    // second mut linear binding
    for it in items {
        a = send(a, it)?             // if this fails: a is current-a (Failed), b is current-b
        b = mirror(b, it)?           // if this fails: a already rebound this iter, b current
    }
    close(b)
    a
}
```
**Break attempt:** with **two** `mut` linear bindings, on a `?` the error path must thread
**both** at their **current** values. R4 as stated mentions "a `mut` linear binding"
(singular). **Does it generalize to N?**

**Finding:** R4 generalizes, but the statement must be pluralized and made precise: *on `?`,
**every** in-scope linear binding (mut or not) must be accounted for at its **current**
value — threaded into the error or disposed.* The error type here returns **both** conns.
This is just R2 (caller-owned / threaded-out) applied per-binding, with "current value" from
R4. So **R4 + R2 compose**, but the combined rule is: "*every* live linear binding, at its
current value, must have an exit disposition." Singular R4 was an under-statement. **E1
generalizes R4 — no break, but a required restatement.**

### E.2 mut linear across a conditional (not a loop)
```fit
let mut c = connect()?
if needs_auth {
    c = authenticate(c)?     // ? here: thread current c (post-connect) into error
}
c = send(c, payload)?        // ? here: thread current c (possibly post-auth) into error
```
**Finding:** holds. The "current value" is whatever the most recent rebind produced on the
taken branch. Control flow doesn't break R4 because "current binding value" is always
well-defined at any program point. **PASS.**

### E.3 BREAK #E3 — mut linear captured by a closure
```fit
let mut c = connect()?
let f = || send(c, ping)     // does the closure capture c by move? then c is consumed HERE
c = retry(c)?                // ERROR: c was moved into the closure; no longer owned
```
**Finding — a real break of naive R4:** if a `mut` linear binding is captured by a closure,
"current value" becomes ambiguous — the closure may have consumed it, or may consume it
later, or never. Linearity + closures + mutation is a known hard intersection (Rust forbids
much of this; it's why `FnOnce` exists). **R4 does not, by itself, resolve closure capture.**
The required rule: **a linear value may be captured by an `FnOnce`-style closure (consumed
at most once) but then the binding is moved and cannot be rebound;** a `mut` linear binding
**cannot** be captured and still remain live for rebinding. This is a genuine restriction R4
did not anticipate. **E3 is a real find: closures over mut linear bindings need their own
rule; R4 alone is insufficient.**

### E.4 Verdict E
- R4 generalizes to **N bindings** (E1) and across **conditionals** (E2): restate it as
  "every live linear binding, at current value, must have an exit disposition." **PASS with
  restatement.**
- R4 **breaks** at **closure capture** (E3): the linear+mut+closure intersection needs an
  explicit `FnOnce`-style rule. This is the one genuine new hole found in Test E. **PARTIAL.**

---

## Consolidated findings

| Test | Target | Result |
|------|--------|--------|
| **C** | Illegal transitions vs. real TCP | Local-call: **PASS**. Event-driven/branching: **model incomplete** — needs "sum-over-next-states + mandatory match" companion to typestate. Guarantee survives. |
| **D** | Affine cells | **HOLD**, but require sharpened rule **D1**: affine legal *only* when drop is a true no-op; anything with disposal cost is linear. Affine exempt from R4. |
| **E** | R4 generality | Generalizes to N bindings & conditionals (**restate R4**). **Breaks at closure capture (E3)** — needs an FnOnce-style rule for linear+mut+closures. |

### The three things that must be ADDED to the model
1. **Event-driven transition rule (from C):** transitions whose outcome depends on remote
   events/races are returned as **sum types over possible next-state typed handles**; the
   caller must `match` to get a usable handle. Typestate governs *legality within a state*;
   sum-over-states governs *event-driven movement between states*. (No new machinery — sum
   types exist — but the **combination rule** is new and load-bearing. This is the biggest
   finding.)
2. **Affine soundness rule D1:** affine ⇔ drop is observationally a no-op. Real disposal ⇒
   linear.
3. **Linear-mut-closure rule (from E3):** capture of a linear value is `FnOnce`-style and
   moves the binding (no further rebind); a `mut` linear binding cannot be captured and
   remain live. Restate **R4** as: *on `?`, every live linear binding at its current value
   must have an exit disposition.*

### What survived intact
- Illegal **local** transitions still won't compile (the headline demo).
- The 3×2 matrix structure and `mut`'s orthogonality.
- R1, R2, R3, R6 unchanged.

### Honest assessment
This round, unlike the last two, did **not** resolve everything by removing machinery — it
**added three rules**. That is a real signal: we've moved from "is the core coherent?"
(yes) into "what does the core *not yet cover?*" (event-driven state, affine drops, closure
capture). None of the three additions contradicts the core; each is a *composition rule*
between features that already exist. But the count matters: **three additions in one round
is the first sign that the "tiny core" is meeting the real complexity of its target
domain.** The next consolidation should fold these in and re-check that "one mechanism,
several hats" is still an honest description — or whether it's now "one core mechanism plus
a small, fixed set of composition rules," which is a slightly different (and still
defensible) claim.
