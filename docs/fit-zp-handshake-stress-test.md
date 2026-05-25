# FIT — §7.2 Keyboard Test: A PQ Transport Handshake

> **Purpose.** §7.2 of the design doc claims: *a failed consuming operation returns its
> resource in a declared failure typestate (`Poisoned`), carried in the error tuple;
> `close` is total over all states; the threading sugar absorbs the error-arm rebind.*
> This is the first attempt to write a real, multi-state, multi-failure handshake in FIT
> syntax and see whether that claim survives. **Verdict: the core claim holds, but the
> exercise forced three refinements and exposed one gap the type system can't close.**
>
> The handshake is **representative**, not wire-faithful to `zp_specification_v1.0.md`
> (which isn't accessible from this session). The realism that matters here — state
> count, distinct failure classes, owned secrets — is present. The real zp states may
> push §7.2(F5) harder; noted at the end.

---

## 1. The handshake shape

Hybrid PQ handshake: ephemeral classical DH + PQ KEM, signature authentication over the
transcript, then key confirmation before any application data.

```
Fresh ─gen_ephemerals─▶ EphemeralsReady ─send_client_hello─▶ ClientHelloSent
      ─recv_server_hello─▶ ServerHelloProcessed ─verify_peer─▶ PeerAuthenticated
      ─confirm─▶ Ready
                                   (any step fails) ─▶ Poisoned
```

Five consuming transitions, each can fail; failure goes to `Poisoned`. App data is only
valid in `Ready`.

---

## 2. The types

```fit
// A linear sub-resource holding ALL secret material, regardless of handshake state.
// Its single consumer is zeroize(). This uniformity is what lets `close` be total —
// see Finding F2.
resource KeyMaterial            // linear; the obligation is "must be zeroized once"

secret field bytes in KeyMaterial   // `secret` = codegen contract, NOT type discipline:
                                     //   (a) un-elidable overwrite on zeroize
                                     //   (b) no implicit copies. See Finding F4 (the gap).

fn zeroize(k: KeyMaterial)      // total, INFALLIBLE; the only way to discharge KeyMaterial

// The connection. Carries exactly one KeyMaterial in every state S.
resource Connection<S>          // linear (strictly once — NOT affine; see Finding F5)
```

States: `Fresh | EphemeralsReady | ClientHelloSent | ServerHelloProcessed |
PeerAuthenticated | Ready | Poisoned`.

---

## 3. The transition signatures — note the audit surface

```fit
fn connect(addr: Address) using Net
    -> Result<Connection<Fresh>, IoError>

fn gen_ephemerals(c: Connection<Fresh>) using Rng                      // entropy is a capability
    -> Result<Connection<EphemeralsReady>, (RngError, Connection<Poisoned>)>

fn send_client_hello(c: Connection<EphemeralsReady>) using Net
    -> Result<Connection<ClientHelloSent>, (IoError, Connection<Poisoned>)>

fn recv_server_hello(c: Connection<ClientHelloSent>) using Net
    -> Result<Connection<ServerHelloProcessed>,
              (IoError | DecapError | ProtocolError, Connection<Poisoned>)>

fn verify_peer(c: Connection<ServerHelloProcessed>)                    // NO capabilities — pure crypto
    -> Result<Connection<PeerAuthenticated>, (AuthError, Connection<Poisoned>)>

fn confirm(c: Connection<PeerAuthenticated>) using Net
    -> Result<Connection<Ready>, (IoError | MacError, Connection<Poisoned>)>

fn close(c: Connection<S>)      // total over EVERY state incl. Poisoned; INFALLIBLE (F3)
```

**The audit surface works exactly as promised.** Read the signatures:
- `verify_peer` has **no capability requirement at all** → it provably cannot touch the
  network, the disk, or even entropy. A reviewer confirms "authentication is a pure
  function of the transcript" *from the type alone*.
- `gen_ephemerals` needs `Rng` but not `Net`; the network steps need `Net` but not `Rng`.
  Each step can do exactly what it must and no more.
- Every fallible step's failure type names its real failure causes — `recv_server_hello`
  can fail three distinct ways, all visible.

---

## 4. The driver — and the first refinement it forced

```fit
fn open_secure(addr: Address) using Net, Rng
    -> Result<Connection<Ready>,
              IoError | RngError | DecapError | ProtocolError | AuthError | MacError> {
    using conn = connect(addr)? cleanup close {
        conn = gen_ephemerals(conn)?      // Fresh            -> EphemeralsReady
        conn = send_client_hello(conn)?   // EphemeralsReady  -> ClientHelloSent
        conn = recv_server_hello(conn)?   // ClientHelloSent  -> ServerHelloProcessed
        conn = verify_peer(conn)?         // ServerHelloProcessed -> PeerAuthenticated
        conn = confirm(conn)?             // PeerAuthenticated -> Ready
        conn                              // SUCCESS: hand the Ready connection OUT
    }
}
```

**Finding F1 — `cleanup`-on-every-exit (§4.2) is WRONG for factory patterns.**
The file-read example in §8.2 closed the file on success, which hid this. Here, **success
must NOT close** — it returns the live `Ready` connection to the caller. If `cleanup`
fired on every exit as §4.2 states, `open_secure` would zeroize and drop the very
connection it's supposed to return.

**Corrected rule (linearity-consistent):**
> `cleanup` is the *default* discharge of a linear obligation. **Returning the resource
> transfers the obligation to the caller and disarms `cleanup`.** Cleanup fires on a
> given exit path iff the value would otherwise be dropped on that path.

This is the C++ `ScopeGuard::dismiss()` / "commit-or-rollback" pattern — but automatic,
because linearity already tracks exactly where the obligation goes. On the `conn` (success)
line the obligation rides out with the return value; on every `?` line it doesn't, so
`close` fires. No annotation needed; the compiler knows from whether `conn` escapes.

---

## 5. What the desugaring proves (no runtime magic)

```fit
fn open_secure(addr: Address) using Net, Rng -> Result<Connection<Ready>, ...> {
    let conn = connect(addr)?                              // connect failed: nothing acquired, return
    // cleanup armed: close(conn) fires on any error exit below; DISARMED if conn escapes
    let conn = gen_ephemerals(conn)    else (e, conn) -> { close(conn); return Err(e) }
    let conn = send_client_hello(conn) else (e, conn) -> { close(conn); return Err(e) }
    let conn = recv_server_hello(conn) else (e, conn) -> { close(conn); return Err(e) }
    let conn = verify_peer(conn)       else (e, conn) -> { close(conn); return Err(e) }
    let conn = confirm(conn)           else (e, conn) -> { close(conn); return Err(e) }
    Ok(conn)                                              // escapes: close NOT called
}
```

Every error arm is a plain `close(conn); return Err(e)` — visible, no hidden behaviour.
The failure typestate (`Poisoned`) is what makes `conn` in the `else` arm have a `close`
to call. The sugar removed five hand-written match arms (plumbing), not a single decision.

---

## 6. The compile-time demos (the 5-second sells)

```fit
// Wrong order — app data before key confirmation:
using conn = connect(addr)? cleanup close {
    conn = gen_ephemerals(conn)?
    send(conn, app_data)?       // ✗ send requires Connection<Ready>; conn is EphemeralsReady.
}                               //   The operation does not exist in this state.
```

```fit
// Skipping confirmation — the security-critical one:
conn = verify_peer(conn)?       // conn : Connection<PeerAuthenticated>
send(conn, app_data)?           // ✗ still not Ready. You CANNOT transmit application data
                                //   on a connection whose keys aren't confirmed — it does
                                //   not typecheck. The protocol ordering IS the type.
```

```fit
// Using a moved connection:
let ready = open_secure(addr)?
close(ready)
send(ready, data)?              // ✗ `ready` was consumed by close; linear value already used.
```

```fit
// Forgetting a step — falls out of linearity, not a special check:
using conn = connect(addr)? cleanup close {
    conn = gen_ephemerals(conn)?
    conn                        // ✗ block must yield Connection<Ready> (return type);
}                               //   this is Connection<EphemeralsReady>. Type mismatch.
```

---

## 7. Findings

### F1 — `cleanup` semantics corrected *(refinement; see §4)*
"Cleanup on every exit" → "cleanup discharges the obligation *unless* the value escapes
via return." Forced by the factory pattern; invisible in the file-read example. **Feeds
back into the design doc §4.2.**

### F2 — One `Poisoned` suffices, *because* security cleanup is uniform *(holds, sharpened)*
I expected to need several failure states (net-failure vs. crypto-failure vs.
auth-failure) because their cleanup seemed different. It isn't. On *any* poisoned crypto
channel the safe teardown is identical: **zeroize all key material, hard-drop the socket,
never send a graceful close** (a graceful close on a poisoned channel can leak timing/
oracle information). So:

> **Typestate distinguishes by capability/structure; error *values* distinguish by
> cause.** A failed handshake has one capability (`close`) and — via the uniform
> `KeyMaterial` — one structure, so **one `Poisoned` state + a rich error union** is the
> correct factoring. The cause lives in `DecapError | AuthError | MacError | …`, not in
> the type.

This is a genuinely satisfying result and a reusable design principle. But it *depends*
on F3.

### F3 — "total `close`" hides a dispatch problem; the fix is a uniform secret container *(refinement)*
If different states held *structurally different* secrets inline, a single parametric
`close(c: Connection<S>)` couldn't destructure all of them without either a runtime state
tag (costs erasure / adds runtime representation to typestate) or a per-state `close`
family (adds maintenance, "total" becomes "exhaustively re-implemented"). **Resolution:**
every `Connection<S>` owns one linear `KeyMaterial` with its own infallible `zeroize`.
`close` is then genuinely uniform — drop socket, `zeroize(km)` — and "total over all
states" is honest. **Cost:** this sub-resource is a real, required piece of the model, not
free. Also a new rule surfaced: **cleanup functions must be infallible** (no `Result`),
or an error *during* error-cleanup creates infinite regress. §7.2 didn't state either;
both now do.

### F4 — **The gap: linearity ≠ secure erasure** *(type system cannot close this)*
This is the important one for the zp use case. Linearity guarantees `zeroize` is *called
exactly once*. It does **not** guarantee:
- the compiler won't treat the zeroizing overwrite as a **dead store and delete it**
  (this is why Rust needs the `zeroize` crate / `read_volatile`), or
- the secret wasn't **copied** into registers/stack spills the overwrite never touches.

So FIT needs a `secret` qualifier that is a **codegen contract orthogonal to the type
system**: un-elidable (volatile) zeroization, and suppression of implicit copies. Even
then, *full* microarchitectural erasure (no spill residue, constant-time) is not fully
achievable in any current language — so the honest scope is: **FIT can guarantee no
*semantic* copies (linearity) and un-elidable zeroize (`secret` codegen), but cannot
guarantee zero microarchitectural residue.** This must be stated plainly; a security
language that over-promises here is worse than one that scopes it.

### F5 — The handshake validates strictly-linear (not affine) resources *(holds, confirms earlier choice)*
A half-open `Connection` must never be silently dropped — that would leak the socket and,
worse, leave key material un-zeroized. Strict linearity (*must* consume) is exactly what
forces every path to either `close` or hand off. Affine (*may* drop) would silently leak
secrets. The earlier lean toward linear-for-resources is **confirmed by a real security
case**, not just aesthetics.

---

## 8. Did §7.2's core claim survive?

**Yes.** Failure-as-typestate-edge did not create a second model: a failing step is a
`Connection<Sₙ> → Connection<Poisoned>` transition (same axis as success transitions) that
additionally carries an error value. No new mechanism — failure is the state machine
taking an edge you'd rather avoid, precisely as claimed. The "one substructural core,
several hats" story is intact.

**But the claim was incomplete.** Making it real required: F1 (disarm-on-return), F3
(uniform `KeyMaterial` + infallible cleanup). And it exposed F4 (the secure-erasure gap),
which no amount of type design fixes — it's a codegen obligation. F2 and F5 are wins that
*strengthen* the model.

---

## 9. Feeds back into the design doc

- **§4.2** — rewrite cleanup semantics per F1 (disarm on escape).
- **§7.2** — add: infallible-cleanup rule (F3); the typestate-vs-error-value factoring
  principle (F2).
- **New section needed** — `secret` as a codegen contract, with honestly scoped
  guarantees (F4). This is a *third* leg alongside linearity and capabilities for the
  security story, and it lives below the type system.
- **§3 / resource model** — cite this handshake as the concrete justification for
  strictly-linear (not affine) resources (F5).

## 10. The next harder test
The real `zp` states (rekeying, 0-RTT/early-data, connection migration, post-handshake
re-authentication) introduce transitions that are **not** monotonic toward `Ready` and may
hold *multiple* live key generations at once. Two specific stressors to run when the spec
is reachable:
1. **Rekey** — a `Ready → Ready` transition that swaps key material while the old keys
   may still be needed for in-flight data. Does one `KeyMaterial` suffice, or does `Ready`
   transiently own two? If two, F2's "uniform structure" claim needs re-examination.
2. **0-RTT early data** — sending app data in a state that is *not yet* fully confirmed.
   This deliberately weakens the §6 demo ("no app data before `Ready`"); FIT would need a
   distinct `EarlyData` typestate with explicitly weaker guarantees, visible in the type.
   That's the right outcome — but it must be designed, and it pressures the "one `Poisoned`"
   simplicity if early-data failures need different teardown.
