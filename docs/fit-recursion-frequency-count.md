# FIT — How Much Code Actually Hits the Recursion Case?

> **Claim under test:** Path 1's recursion is forced ONLY for a loop that transitions state
> mid-iteration and must continue in the new state ("drain-after-transition"). Everything
> else — straight-line state machines, non-transition ops, lent resources — uses plain
> loops/sequences. **Method:** write a realistic protocol end-to-end and count every
> control structure, classifying each as PLAIN or RECURSION-FORCED.
>
> **Target:** a TCP-style connection lifecycle (active open → data transfer with keep-alive
> → graceful close, including the peer-FIN / CloseWait drain). Sigil-free borrow (compiler
> infers lend vs. consume from signature). `using ... cleanup` kept for owned resources.

---

## The full lifecycle, annotated per control structure

```fit
resource Conn { sock: Socket, cleanup: shutdown }      // linear; lend inferred when not consumed

// ---------- [1] CONNECT: straight-line sequence, no loop ----------
fn establish(addr: Address) using Net -> Result<Conn, ConnError> {
    using c = open_socket(addr)? cleanup shutdown {     // owned; using guards error path
        syn(c)?                                         // lend c (not consumed) - inferred
        syn_ack_wait(c)?                                // lend
        ack(c)?                                         // lend
        c.release()                                     // hand ownership out of the using
    }
}
//  CONTROL STRUCTURES: 0 loops. Straight-line. -> PLAIN (sequence). [no recursion]

// ---------- [2] SEND a message: a loop over chunks, NO state change ----------
fn send_message(c: Conn, msg: Bytes) using Net -> Result<Conn, (SendError, Conn)> {
    using c = c cleanup shutdown {                      // (kept) owned-resource guard
        let mut offset = 0                              // unrestricted data
        loop {                                          // <-- LOOP
            if offset >= msg.len() { break }
            let n = write_some(c, msg, offset)?         // lend c; state unchanged
            offset = offset + n                         // data reassign
        }
        c.release()
    }
}
//  LOOP iterates DATA (offset); Conn lent, state never changes. -> PLAIN LOOP. [no recursion]

// ---------- [3] KEEP-ALIVE request/response: a loop, NO state change ----------
fn serve(c: Conn) using Net -> Result<Unit, IoError> {
    using c = c cleanup shutdown {
        loop {                                          // <-- LOOP
            match read_request(c)? {                    // lend c; Established throughout
                ClientClosed => break,
                Timeout      => break,
                Request(req) => {
                    let resp = route(req)               // pure
                    write_response(c, resp)?            // lend c
                }
            }
        }
        // c disposed by using on exit
    }
}
//  LOOP iterates over requests; Conn lent, stays Established. -> PLAIN LOOP. [no recursion]

// ---------- [4] CLOSE with peer-FIN drain: THE transition-mid-loop case ----------
fn drain_and_close(c: Conn) using Net -> Result<Unit, IoError> {
    // we are Established; peer may FIN -> we must drain in CloseWait, then close.
    // THIS is the only place state changes WHILE we must keep looping.
    fn drain_loop(c: Conn) using Net -> Result<Unit, IoError> {   // <-- RECURSION-FORCED
        match read_request(c)? {
            ClientClosed => { finish_close(c)?; Ok(unit) }
            Timeout      => { finish_close(c)?; Ok(unit) }
            Request(req) => {
                let resp = route(req)
                let c = write_response_keep(c, resp)?
                drain_loop(c)                            // tail recursion: continue draining
            }
        }
    }
    drain_loop(c)
}
//  Mid-loop transition (Established -> CloseWait drain). -> RECURSION-FORCED. [the 1 case]
```

NOTE on [4]: even here, recursion is only forced *if* we want the loop to carry a
**type-changing** handle across the transition. If state is tracked as DATA (the B-data
approach), [4] is also a plain loop — at the cost of runtime-checked ordering. So [4] is
recursion-forced ONLY under the compile-time-ordering choice (Path 1).

---

## The count

| # | Component | Control structure | Classification |
|---|-----------|-------------------|----------------|
| 1 | establish (connect handshake) | straight-line sequence | PLAIN |
| 2 | send_message (chunked write) | loop over data | PLAIN |
| 3 | serve (keep-alive req/resp) | loop over requests | PLAIN |
| 4 | drain_and_close (peer-FIN drain) | loop across transition | **RECURSION-FORCED** |

**4 components, 3 control loops + 1 sequence. Recursion forced in 1 of 4 components — and
only in the sub-case where that component crosses a state boundary while looping.**

By line count in this (representative) lifecycle: the recursion-forced block is ~8 of ~55
lines (~15%), and it's the *single* place a loop crosses a state transition. Every other
loop (the high-frequency ones — chunked I/O, keep-alive request handling) is plain.

---

## Findings

**The claim holds.** Recursion is forced **only** at loop-across-transition, which in a real
protocol is rare:
- **Handshakes / setup / teardown sequences** → straight-line, no loop, no recursion.
- **Data-transfer loops** (the hot, frequent code) → iterate DATA with a lent resource whose
  state doesn't change → plain loops.
- **Keep-alive / request loops** → state stays constant (Established) → plain loops.
- **Only "keep looping while the connection's state changes underneath you"** → recursion.

This is a *much* narrower mandate than "state machines are recursive." It's: **the specific
moment you loop ACROSS a state boundary and want that boundary compile-enforced.** Most state
machines change state in straight-line code (handshakes) or don't change state inside their
loops (data transfer) — neither forces recursion.

**Two honest caveats:**
1. Some protocols are *mostly* transitions (a complex negotiation with many branching states
   and loops between them). Those would hit recursion more often. The 15% here is typical for
   transport-style protocols; a heavily stateful negotiation protocol could be higher. Not
   universal.
2. Even the 1 forced case is only forced under Path 1 (compile-time ordering). Choose runtime
   ordering for *that one loop* and it's plain too — meaning you could even go **hybrid**:
   compile-enforce ordering everywhere it's free (straight-line transitions), and accept
   runtime-checked ordering for the rare drain-across-transition loop. That hybrid keeps
   plain loops everywhere AND keeps compile-time safety for all the non-loop transitions
   (which is most of them).

---

## The hybrid this surfaces (genuinely new option)

The count reveals a third path we hadn't named:

**Path 3 — Compile-enforce ordering for straight-line transitions (free, no recursion);
allow runtime-checked ordering ONLY inside a loop-that-crosses-a-transition (rare).**

- Handshake misuse (`send` before `connect`) → straight-line → **compile error**. Caught.
- Data/keep-alive loops → no transition → plain loops, fully safe.
- Drain-across-transition loop → the one spot → runtime-checked, plain loop.

This gets compile-time ordering for the *vast majority* of protocol-ordering bugs (which are
in setup/teardown sequences, not mid-drain loops), keeps plain loops everywhere, and confines
the "give up compile enforcement" to ~15% of one component. **It may be the actual sweet
spot** — most of Path 1's safety, almost none of its recursion cost.

---

## Verdict

Recursion-forced frequency in a representative transport protocol: **~1 in 4 components,
~15% of lines, confined to loop-across-transition.** The "recursion mandate" is real but
**narrow** — not a pervasive style. And the count exposes **Path 3 (hybrid)**: compile-time
ordering where it's free (straight-line, the common bug site), runtime where it'd cost
recursion (rare drain loops). Path 3 is the next thing to pressure-test — if it holds, FIT
gets most of its differentiator with little of the cost.
