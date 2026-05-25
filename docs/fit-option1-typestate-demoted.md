# FIT — Option 1 Experiment: HTTP Server with Typestate DEMOTED to a Pattern

> **The experiment:** rewrite the exact same HTTP/1.1 keep-alive server, but with typestate
> as *nothing more than distinct structs the programmer chooses to make* — no compiler-
> enforced state parameters, no type-changing bindings, plain loops allowed. Then check,
> one by one, whether INT-1 → INT-4 (and EVT, the recursion mandate, mandatory TCO)
> survive or evaporate.
>
> **Falsification target:** the hypothesis that "most of rounds 3–5's machinery was an
> artifact of typestate-as-core, not of FIT's actual thesis." If the server gets clean,
> hypothesis confirmed. If it's still tangled, that points to Option 3.

---

## 1. What "typestate as a pattern" means here

The connection is **one linear resource of one type**: `Conn`. It does NOT change type as
it moves through the protocol. If a programmer *wants* compile-time state discipline they
can make distinct structs — but for this server we test the *common* path: a single linear
`Conn`, with protocol state handled as ordinary data/return values, the way a normal
programmer would write it.

```fit
resource Conn          // ONE linear type. cleanup = shutdown, declared ONCE at the type.
capability Net
```

Note the second line of the comment: **cleanup declared once, at the type.** This is the
Test-D lesson (a secret's cleanup is "zeroize," intrinsic to the type) applied to the
connection. A `Conn`'s disposal is *part of what a `Conn` is*. Hold that thought — it's the
key to INT-1/INT-2.

---

## 2. The server, written as a normal programmer would

```fit
// transitions are ordinary functions. state is just "what you got back," not a type param.
fn read_request(c: Conn) using Net -> Result<RequestOutcome, IoError>

enum RequestOutcome {
    Request(ParsedRequest),    // got a request (the Conn is threaded, see below)
    ClientClosed,              // peer closed
    Timeout,                   // idle timeout
}

fn write_response(c: Conn, resp: Response) using Net -> Result<Unit, IoError>
fn route(req: ParsedRequest) -> Response       // PURE. no `using` -> provably no I/O.

// ---- the connection lifecycle: a PLAIN LOOP. no recursion mandate. ----
fn serve_connection(c: Conn) using Net {        // c is linear; cleanup=shutdown is intrinsic
    loop {
        match read_request(c)? {                // ? disposes c via intrinsic cleanup on error
            ClientClosed => break,
            Timeout      => break,
            Request(req) => {
                let resp = route(req)            // pure
                write_response(c, resp)?         // ? disposes c via intrinsic cleanup on error
                // keep-alive: just loop. no type change, no tail call, no TCO needed.
            }
        }
    }
    // c disposed here by its intrinsic cleanup (shutdown) on normal exit. ONE place.
}

fn main() using Net -> Result<Unit, BindError> {
    let listener = bind(":8080")?
    loop {
        let c = accept(listener)?               // c: Conn, linear, intrinsic cleanup
        serve_connection(c)                     // moves c in; serve_connection owns disposal
    }
}
```

Wait — there's a subtlety I must not skip (honesty rule): in the `Request` arm,
`read_request(c)` took `c`. Does the loop still "have" `c` on the next iteration? Under
strict linearity, `read_request` consuming `c` means `c` is gone. Two clean ways to handle
it, NEITHER requiring typestate or recursion:

**(2a) Functions borrow-for-duration via the linear-threading sugar** (the §4.4 mechanism
we already have): `read_request(c)` returns the `Conn` alongside its outcome, and the
`mut`-binding sugar rebinds it — SAME TYPE every time, so `mut` works fine (this was the
EXACT thing that broke under typestate, and it's fine now):

```fit
fn serve_connection(mut c: Conn) using Net {     // mut over a SINGLE type — no conflict
    loop {
        let outcome = read_request(c)?           // sugar: c threaded back, rebound (same type)
        match outcome {
            ClientClosed => break,
            Timeout      => break,
            Request(req) => {
                let resp = route(req)
                write_response(c, resp)?          // sugar: c threaded back, rebound
            }
        }
    }
}                                                 // intrinsic cleanup fires once, here
```

This is the whole thing. A plain loop, a `mut` binding over one type, the threading sugar
doing what it already does. **No recursion. No TCO. No EVT rule. No `using c = c`.**

---

## 3. INT-1 → INT-4, checked one by one

### INT-1 (`using c = c cleanup shutdown` wart) — **GONE**
Cleanup is intrinsic to the `Conn` type (declared once), so there is never a need to wrap an
already-owned value in a `using` just to attach disposal. The wart existed *only* because
typestate-as-core made the connection's type change, which broke the natural "the type
knows its own cleanup" model. Demote typestate → the connection is one type → its cleanup is
intrinsic → the wart has no reason to exist. **Evaporated.**

### INT-2 (disposal narrative fragmented across 3 sites) — **GONE**
With cleanup intrinsic to `Conn`, the disposal story is in *one* place: the type definition.
`accept` produces a `Conn`; whoever owns it at exit triggers its one cleanup. No per-scope
re-statement. **Evaporated.**

### INT-3 (mandatory guaranteed TCO) — **GONE**
The recursion idiom was the *only* reason TCO became mandatory. With a plain loop for
keep-alive, there is no per-request stack growth, so TCO is back to being a nice-to-have
optimization, not a correctness requirement. **This is the big one: a major language
commitment just disappeared.** FIT no longer must guarantee TCO to have working servers.
**Evaporated.**

### INT-4 (tail-move-closes-scope rule) — **GONE**
No tail call, no recursive scope nesting, so the question of whether cleanup obligations
accumulate across tail calls never arises. **Evaporated.**

### EVT (sum-over-next-state-types + mandatory match) — **DEMOTED TO NORMAL PROGRAMMING**
`read_request` returns a plain `enum RequestOutcome`. You `match` it because it's a sum
type, exactly as you would in any language. There is no special "event-driven transition
rule" because there are no type-level states to transition between — just a function
returning one of several ordinary outcomes. EVT stops being a *language rule* and becomes
"functions return enums; you match them." **The load-bearing round-3 finding was an
artifact of typestate.** Evaporated as a *rule*; survives as ordinary good sense.

### The recursion mandate (Test F's core conflict) — **GONE**
The conflict was "`mut` can't change a binding's *type* mid-loop." With states as data
rather than types, the binding's type never changes (`Conn` throughout), so `mut` in a plain
loop works perfectly. The entire EVT×mut conflict that forced recursion **does not exist**
when typestate isn't core. **Evaporated.**

---

## 4. What we LOSE (the honest cost)

The compiler no longer *guarantees* protocol-ordering safety. With typestate-as-core,
`send` on an unconnected socket was a *compile error*. Now, `read_request`/`write_response`
both take a plain `Conn`, so nothing stops a programmer from calling `write_response` before
a request was ever read — it'd be a logic bug caught at runtime/test, not compile time.

**Is that loss acceptable?** Three observations:

1. **It's opt-in, not gone.** A programmer who *wants* the guarantee for a critical protocol
   can still make distinct structs (`Idle`/`Ready`) — the *pattern* (Option-1-as-pattern)
   is available. They pay the recursion/threading cost *only in that module*, by choice, for
   the protocols where it's worth it. The cost is now *local and elective* instead of
   *global and mandatory*.
2. **This matches every mainstream systems language.** Go, C, Rust (mostly) catch protocol-
   ordering bugs at runtime/test, not compile time. FIT-without-typestate-core is in
   excellent company; FIT-with-typestate-core was in the company of academic session-type
   languages that nobody ships.
3. **The thing we kept is the thing that was actually novel-and-working:** the *purity audit
   surface* (`route` provably can't do I/O) is STILL fully enforced here, because that comes
   from **capabilities**, not typestate. We lost the seductive demo; we kept the load-bearing
   guarantee.

---

## 5. Verdict

**Hypothesis CONFIRMED, strongly.** Demoting typestate from core to optional pattern made
INT-1, INT-2, INT-3, INT-4, the EVT rule, the recursion mandate, and mandatory TCO **all
evaporate simultaneously.** They were not seven independent findings — they were **one root
cause (typestate-as-core) viewed seven ways.** That is exactly the kind of single-root
collapse that indicates we found the real problem, not a patch.

What remains after demotion is clean and small:
- **Capabilities as signature requirements + purity audit surface** — fully intact, still
  the strongest idea, still enforced.
- **Linear resources with intrinsic, declared-once cleanup** — now *cleaner* than before
  (INT-1/INT-2 gone).
- **Errors as values, failures in the signature** — intact.
- **Plain loops AND recursion both available**, programmer's choice — the philosophical
  defect you flagged is gone.
- **Typestate available as an opt-in pattern** for the rare protocol that earns it.

The HTTP server above is something a competent programmer reads top-to-bottom and
understands. No `using x = x`. No recursion mandate. No TCO footnote. **That is the
"readable without comments" tenet actually holding.**

---

## 6. What this means for FIT's thesis (the recenter)

The five rounds of testing were not wasted — they *located the tumor*. FIT's real thesis,
stripped of the feature that generated every contradiction:

> **A small systems→server→data language where authority and resource-disposal are visible
> in the type — no GC, no exceptions, no ambient authority — using ordinary control flow.
> Capabilities and linear resources are the core. Everything else is opt-in.**

Typestate goes in the toolbox, not the foundation.

**Honest remaining question for the next pass (NOT to patch now):** is the surviving core
**meaningfully different from Austral** (linear types + capabilities, already exists)? This
is the Option-3 question, and it's now the *real* one. Demoting typestate removed FIT's
contradictions — but it may also have removed its novelty, leaving "Austral with nicer
ergonomics." Whether "nicer ergonomics + intrinsic cleanup + the specific capability model
we designed" is *enough* to justify a new language is the genuine open question. It is no
longer a question about whether FIT is *coherent* (it now is). It is a question about
whether FIT is *necessary*. That deserves its own honest examination — and it is the right
place to stop adding and start deciding.
