# FIT — End-to-End Integration Test: HTTP/1.1 Keep-Alive Server

> **The test every prior round deferred.** Each slice was verified alone; this writes ONE
> complete, real, multi-state program end-to-end and asks: are the pieces — each correct
> individually — actually *pleasant together*, or merely *possible*?
>
> **Target:** an HTTP/1.1 connection handler with keep-alive (RFC 7230). Chosen because it
> is real, frozen, and exercises **everything at once**: capabilities (`Net`), a linear
> resource (the connection), event-driven state (client may close, send another request, or
> time out), the recursion idiom (Test F's resolution), the full error model, and disposal.
> If the combination is ugly, this is where it shows.
>
> **Honesty rule:** write it as a user actually would, then judge the result without mercy.
> Illustrative syntax; the question is *shape and ergonomics*, not token choices.

---

## 1. The protocol shape (HTTP/1.1 keep-alive)

```
accept -> [ read request -> route -> write response -> (keep-alive? loop : close) ]
```
Per connection, after each response the client may: send another request (loop),
close the connection (we're done), or go idle until timeout (we close). The
"loop-or-close" decision is **event-driven** (depends on the `Connection:` header AND on
what the client actually does next) — exactly the EVT case, and exactly the place Test F
said to use **recursion, not a loop**.

---

## 2. The full program, written as a user would

```fit
// ---- capability + resource declarations ----
resource Conn<S>                       // S: Idle | Reading | Writing | Closing
capability Net                         // authority-bearing, runtime-rooted

// ---- event-driven transition: what the client does next is not known at compile time ----
fn next_request(c: Conn<Idle>) using Net
    -> Result<RequestOutcome, RecvError>

enum RequestOutcome {
    Request(Request, Conn<Reading>),   // client sent another request
    ClientClosed(Conn<Closing>),       // client closed the connection
    Timeout(Conn<Closing>),            // idle too long
}

// ---- straight-line, precisely-typed transitions ----
fn parse(c: Conn<Reading>, raw: Request)
    -> Result<(ParsedRequest, Conn<Writing>), (ParseError, Conn<Closing>)>
fn write_response(c: Conn<Writing>, resp: Response)
    -> Result<Conn<Idle>, (WriteError, Conn<Closing>)>     // back to Idle = keep-alive
fn shutdown(c: Conn<Closing>)                              // total; the disposal path

// ---- routing is PURE: unrestricted data in, unrestricted data out, cannot touch the world ----
fn route(req: ParsedRequest) -> Response          // no `using` -> provably no I/O. audit surface.

// ---- the connection lifecycle: RECURSION over states (Test F idiom) ----
fn serve_connection(c: Conn<Idle>) using Net -> Result<Unit, ConnError> {
    match next_request(c)? {
        ClientClosed(c) => { shutdown(c); Ok(unit) }      // done, clean
        Timeout(c)      => { shutdown(c); Ok(unit) }      // done, clean
        Request(raw, c) => {
            // c : Conn<Reading>
            using c = c cleanup shutdown {                 // adopt for the fallible middle
                let (parsed, c) = parse(c, raw)?           // Reading -> Writing (or Closing+err)
                let resp        = route(parsed)            // pure; no capability needed
                let c           = write_response(c, resp)? // Writing -> Idle (keep-alive)
                // tail call: continue the SAME connection in Idle. recursion = the loop.
                serve_connection(c)
            }
        }
    }
}

// ---- the accept loop: this IS a loop, because each iteration's resource is independent ----
fn main() using Net -> Result<Unit, BindError> {
    let listener = bind(":8080")?
    loop {
        using c = accept(listener)? cleanup shutdown {     // one connection per iteration
            serve_connection(c)?                           // recursion handles its lifecycle
        }                                                  // shutdown if serve errored out
    }
}
```

---

## 3. Judging it without mercy

### 3.1 What reads CLEANLY (genuine wins)
1. **The data/state division is visible and correct.** `route` is pure — no `using Net`, so
   it *provably cannot* touch the network or disk. A reviewer sees the whole I/O surface in
   the signatures. This is the audit-surface tenet paying off in real code, not slideware.
2. **The accept loop is a loop; the connection lifecycle is recursion.** Test F's division
   ("loops iterate data, recursion advances state") landed *naturally* here — I didn't have
   to force it. The accept loop's resource is independent per iteration (a real loop); the
   connection's state changes per step (recursion). They sit side by side without friction.
3. **Keep-alive falls out for free.** `write_response` returning `Conn<Idle>` and the tail
   call `serve_connection(c)` *is* keep-alive. The state type encodes the protocol's central
   feature with zero special handling.
4. **The event-driven branch (`next_request`) is honest.** Three real outcomes, three typed
   handles, a mandatory `match`. You cannot forget the timeout case — it won't compile.

### 3.2 What's AWKWARD (the real findings)
1. **`using c = c cleanup shutdown` is genuinely ugly.** Re-binding `c` to itself purely to
   attach a cleanup handler reads like ceremony. The connection arrived owned (from the
   `match`), and we need a cleanup scope around the fallible middle — but `using c = c` is a
   wart. **Finding INT-1: there is no clean way to "attach a cleanup obligation to an
   already-owned linear value" without the `using x = x` self-rebind.** This wants a
   dedicated form (e.g. `with cleanup shutdown for c { ... }`), i.e. a real syntax gap, not
   just token choice.
2. **Cleanup is specified at THREE sites for the same resource** (`accept`'s `using`,
   `serve_connection`'s `using c = c`, and the `shutdown` calls in the close arms). For one
   logical resource that should have *one* disposal story, the obligation is smeared across
   three places. **Finding INT-2: per-scope cleanup, while sound, fragments the disposal
   narrative of a long-lived resource that crosses many functions.** A reader can't see "how
   is a connection torn down" in one place.
3. **The recursion idiom hides a real concern: is it a TAIL call?** `serve_connection(c)`
   recursing per request means a long-lived keep-alive connection handling thousands of
   requests must **not** grow the stack. This *requires guaranteed tail-call optimization* —
   which is a real language commitment, not a detail. **Finding INT-3: the recursion idiom
   for state machines makes guaranteed TCO a HARD REQUIREMENT, not optional.** Without it,
   every keep-alive server is a stack-overflow waiting to happen. This is a significant
   constraint Test F glossed: "use recursion" silently assumed FIT guarantees TCO.

### 3.3 What BROKE (one genuine semantic problem)
**Finding INT-4 — the `match` arms and the `using` scope don't compose cleanly.** Look at
the `Request` arm: `c` enters as `Conn<Reading>`, gets wrapped in `using c = c cleanup
shutdown`, and inside, `parse`/`write_response` rebind it through `Writing -> Idle`. The
tail call `serve_connection(c)` happens **inside** the `using` block. But `serve_connection`
**consumes** `c` (takes ownership). So at the tail call, `c` is moved out — and per R3,
`using`'s `cleanup shutdown` should NOT fire (good). But the tail call is *recursive* and
itself sets up a new `using` for the next request. So the cleanup scopes **nest one level
deeper per request**, even with TCO collapsing the stack frames. **The cleanup obligations
may not collapse even if the stack frames do.** Does TCO preserve the "cleanup already
discharged by move" reasoning across the tail call? If the `using` scope is considered
"still open" at the tail call, we leak scopes; if it's considered closed (because `c` moved
out), we're fine. **This is genuinely unclear in the model as written** and is the kind of
thing that's only visible when you write the whole loop. It needs an explicit rule: *a tail
call that moves the linear value out of a `using` scope closes that scope (cleanup already
satisfied by the move), so recursion does not accumulate cleanup obligations.* Plausible,
but it was NOT in the model, and it's load-bearing for every long-lived connection.

### 3.4 What I had to NOT do (scope honesty)
I did not handle: request bodies/streaming (would add another linear resource — the body
reader — inside the request, testing R2 again at depth), chunked encoding, or concurrent
connections (deferred async). These would stress the model further; this test is the
single-connection keep-alive spine only.

---

## 4. Verdict

**The integration mostly works, and the pieces DO fit — but writing the whole thing
surfaced four findings no slice test could:**

| # | Finding | Severity |
|---|---------|----------|
| INT-1 | No clean way to attach cleanup to an already-owned value (`using c = c` wart) | **Syntax gap** — wants a dedicated form |
| INT-2 | Disposal narrative of a long-lived resource is fragmented across scopes/functions | **Ergonomic** — sound but hard to read holistically |
| INT-3 | Recursion idiom makes **guaranteed TCO a hard language requirement** | **Major** — a real commitment Test F glossed |
| INT-4 | Tail call moving a linear value out of a `using` scope needs an explicit "scope closes, cleanup discharged" rule, or recursion leaks scopes | **Semantic gap** — load-bearing, was not in the model |

**The good news:** the *core* held again — capabilities, purity/audit-surface, typestate,
the data/recursion division, keep-alive-via-type — all genuinely clean and arguably
*better* than equivalent C or Go (the I/O audit surface especially). No core mechanism
broke.

**The sobering news:** three of four findings are about the **recursion idiom and
cleanup-across-scopes** — i.e. the seams *between* features in a long-lived program, not the
features themselves. INT-3 (mandatory TCO) and INT-4 (scope-closing-on-tail-move) are real
language commitments that the slice tests structurally could not reveal, because they only
exist when state recurses over a long-lived resource. **This validates that the integration
test was necessary** and that "correct in pieces" did not guarantee "clean in whole."

---

## 5. What this changes in the model

**Must be added:**
- **TCO guarantee** moves from unstated assumption to **explicit language requirement**
  (INT-3). This has implications for the whole calling convention and must be designed in,
  not bolted on.
- **Tail-move-closes-scope rule** (INT-4): a tail call that moves a linear value out of an
  enclosing `using` discharges that scope's obligation; recursion therefore does not
  accumulate cleanup scopes. State explicitly.
- **A cleanup-attachment form** for already-owned values (INT-1), removing the `using x = x`
  wart.

**Should be considered:**
- A way to declare a resource's **disposal once, at its type** (like a linear value's
  intrinsic `cleanup`), so the narrative isn't re-stated per scope (INT-2). This echoes the
  Test D lesson (secret's cleanup = zeroize, declared once). Possibly: linear types may
  carry a *default* cleanup, overridable per scope — reducing fragmentation.

**Unchanged and validated:**
- Capability requirements + purity audit surface (shone here).
- The loops-iterate-data / recursion-advances-state division (landed naturally).
- The error model and typestate sequencing (clean).

---

## 6. Honest status after the integration test

Five rounds. **The core has never broken.** But the integration test did what slices
couldn't: it showed that FIT's *idioms for long-lived stateful programs* (recursion +
per-scope cleanup) carry **two real, previously-unstated language commitments** (guaranteed
TCO; tail-move scope discharge) and **two ergonomic warts** (cleanup attachment; fragmented
disposal narrative). None is fatal; all are addressable. But they move FIT's required
feature set and they make the language's *implementation* commitments larger (TCO is not
free).

**Revised honest pitch (again):** *one substructural core (intact), a small fixed rule set,
the recursion idiom for state machines — and that idiom obligates guaranteed tail-call
optimization and a tail-move scope rule.* The core stayed simple; the **runtime/compiler
commitments grew** (TCO especially). That is the real cost the integration test
uncovered — not in the model's elegance, but in what the implementation must promise.

**The next genuinely unexplored thing:** a program with a **linear resource nested inside
another linear resource's lifetime across recursion** (e.g. streaming a request body: the
body-reader is linear, lives inside one request, while the connection is linear and lives
across many). That double-linear-across-recursion case is the next place to look for a
break, and it is the natural extension of this test.
