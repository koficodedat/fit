# FIT — Standard Library Design Probe Spec

**Date:** 2026-05-27
**Status:** Approved, ready for implementation

---

## Purpose

This probe tests three questions that the PoC and codegen spike could not answer:

1. **How thick is the FFI extern surface in real resource types?** The no-sigil lending differentiator degrades at the FFI boundary. This probe measures whether real resource types — where FFI is only the bottom shim and orchestration is FIT-bodied — produce an acceptable bodied-vs-extern ratio.

2. **Do real resource types fit the resource + typestate model?** The probe stresses three types with different shapes, including the half-shutdown edge case and the validation-typestate hypothesis.

3. **Does typestate-for-data-trust (the candidate "second pillar") emerge naturally from a real HTTP type?** This is the specific reason to run this probe now. The candidate second pillar is that typestate applies not just to protocol state (`Conn<Fresh>` → `Conn<Ready>`) but to data trust (`Request<Raw>` → `Request<Validated>`). The probe tests whether that appears naturally when writing `HttpConn`, or whether it requires contortion. Either answer is a finding.

This is **not** a stdlib build. Three types, one program, then findings. Scope is fixed.

---

## What to build

### Execution order

Bottom-up: `file.fit` → `tcp.fit` → `http.fit` → `server.fit`. Each type is a self-contained experiment before composition.

### Files

```
tests/stdlib-probe/
├── file.fit      # Type 1: File — control case, no typestate
├── tcp.fit       # Type 2: TcpSocket<S> — typestate, half-shutdown probe
├── http.fit      # Type 3: HttpConn — composite, Request representation discovered honestly
└── server.fit    # End-to-end program using all three types (~50–100 lines)
```

Each `.fit` file is independently checkable. `server.fit` re-declares all needed type declarations inline (FIT has no module system; re-declaration is the correct approach for a standalone checkable program).

---

## Type 1 — `File` (`file.fit`)

**Shape:** Linear resource, no typestate. Infallible `force_close` cleanup. Control case: if File doesn't fit cleanly, the model is broken at the simplest level.

**Extern shims (FFI surface):**
```fit
resource File {
    handle:  FileHandle,
    cleanup: force_close,
}

enum IoError { NotFound, PermissionDenied, BrokenPipe }

fn open(path: String) using Fs -> Result<File, IoError>
fn read(f: lend File, buf: lend Bytes) using Fs -> Result<Int, IoError>
fn write(f: lend File, data: Bytes) using Fs -> Result<Int, IoError>
fn seek(f: lend File, pos: Int) using Fs -> Result<(), IoError>
fn close(f: move File) using Fs -> Result<(), IoError>
fn empty_bytes() -> Bytes
fn bytes_to_string(buf: Bytes) -> String
```

**Bodied orchestration:**
```fit
fn read_to_string(f: File) -> Result<String, IoError> {
    let buf = empty_bytes()
    read(f, buf)?
    Ok(bytes_to_string(buf))
}
```

**Key question to observe — correctness and ergonomics of lend/move inference:** The orchestrator asks two related questions here.

*Correctness:* Does `read_to_string` correctly infer move (file consumed-on-error) vs lend (caller retains file)? This is not trivially obvious. The body only passes `f` to `read`, which is a lending callee — so body-based inference says LEND. But on the error path (when `read` fails and `?` fires), `f` is still alive in scope and has not been transferred onward. The checker must correctly distinguish "owned-and-still-present-at-error-exit" (which is not a move-to-consuming-callee) from the MOVE classification. If the checker misclassifies as MOVE, the caller loses `f` on every call — incorrect. If it correctly infers LEND, the caller retains `f` on both success and error paths, and cleanup of `f` on the error path is the caller's responsibility, not the function's. Report which outcome the checker produces and whether it matches the spec's definition.

*Ergonomics:* The orchestrator specifically asks whether "open it, read it, drop it" is clean or requires ceremony. If `read_to_string` infers LEND, the caller must write three steps: `open → read_to_string → close`. If it infers MOVE, the caller writes two: `open → read_to_string` (cleanup is implicit on error, explicit via return value on success). Report which pattern results, and whether it feels natural or ceremonious compared to how a programmer would expect file I/O to work.

---

## Type 2 — `TcpSocket<S>` (`tcp.fit`)

**Shape:** Typestate-driven linear resource. Progression: `Fresh → Connected → Closing`. Half-shutdown modeled honestly.

**Half-shutdown approach:** Attempt to express half-shutdown as `TcpSocket<HalfClosed>`. The expected awkwardness: `tcp_shutdown(dir: Direction)` produces the same `TcpSocket<HalfClosed>` regardless of direction, losing the read/write distinction. Report whether this matters in practice and whether the directional-info loss is an acceptable simplification or a genuine model break.

**Extern shims:**
```fit
enum TcpState { Fresh, Connected, HalfClosed, Closing }

resource TcpSocket<S> {
    fd:      SocketFd,
    cleanup: tcp_force_close,    // infallible C function; fires for any typestate at scope exit
}

enum NetError { Refused, Timeout, Reset, BrokenPipe }
enum Direction { Read, Write }

fn tcp_socket() using Net -> Result<TcpSocket<Fresh>, NetError>
fn tcp_connect(s: move TcpSocket<Fresh>, addr: String, port: Int) using Net -> Result<TcpSocket<Connected>, NetError>
fn tcp_send(s: lend TcpSocket<Connected>, data: Bytes) using Net -> Result<Int, NetError>
fn tcp_recv(s: lend TcpSocket<Connected>, buf: lend Bytes) using Net -> Result<Int, NetError>
fn tcp_shutdown(s: move TcpSocket<Connected>, dir: Direction) using Net -> Result<TcpSocket<HalfClosed>, NetError>
fn tcp_close(s: move TcpSocket<Connected>) using Net -> Result<TcpSocket<Closing>, NetError>
fn tcp_finish(s: move TcpSocket<Closing>) using Net -> Result<(), NetError>
```

Note: `tcp_force_close` is the cleanup label in the resource declaration — it is an infallible C function that handles any socket state at scope exit. It is **not** declared as a typed extern here; the cleanup name is a label for the checker, not a resolved function signature. Do not add a typed `fn tcp_force_close(...)` declaration — that would conflict with the resource-level cleanup semantics.

**Bodied orchestration:**
```fit
fn tcp_roundtrip(s: lend TcpSocket<Connected>, req: Bytes, buf: lend Bytes) using Net -> Result<Bytes, NetError> {
    tcp_send(s, req)?
    tcp_recv(s, buf)?
    Ok(buf)
}
```

Note: the buffer is accepted as a parameter rather than created internally via `empty_bytes()`. This avoids a cross-file dependency: since each `.fit` file is independently checkable, any utility function called inside a bodied function must be declared in the same file. Structuring `tcp_roundtrip` to receive a caller-supplied buffer eliminates the dependency on a file.fit declaration.

**What to observe:** Does `TcpSocket<HalfClosed>` feel like a natural state in the progression, or does it feel like a workaround? Is the directional-info loss (can't distinguish read-half-closed from write-half-closed) a real problem or a non-issue for typical usage? Report honestly.

---

## Type 3 — `HttpConn` (`http.fit`)

**Shape:** Composite resource built on `TcpSocket`. The Request representation is **not pre-decided**.

**Implementation note on field type:** Use `sock: TcpSocket` (un-parameterized, matching smtp.fit's established pattern) rather than `sock: TcpSocket<Connected>`. The current parser's ability to handle parameterized resource types as field types is untested and likely unsupported. The Connected invariant is established by `http_accept()` returning `HttpConn` only from an already-connected socket — the typestate guarantee lives in the factory, not the field.

**What HTTP actually needs:** receive bytes from connection → parse into structured request → validate fields → dispatch to handler that requires a validated request → send response.

**Scaffolding to start from:**
```fit
resource HttpConn {
    sock:    TcpSocket,
    cleanup: http_force_close,
}

enum HttpError { BadRequest, NotFound, InternalError }

// Operations to define — the ??? types are what the probe discovers:
//   http_accept() using Net -> Result<HttpConn, NetError>
//   http_receive(conn: lend HttpConn) -> Result<???, HttpError>
//   validate(req: ???) -> Result<???, HttpError>
//   http_send(conn: lend HttpConn, resp: Response) -> Result<(), HttpError>
//   http_close(conn: move HttpConn) using Net -> Result<(), HttpError>
```

**The validation-typestate probe (question 3):** Write the `http.fit` type starting from what HTTP protocol operations actually need. Let whatever representation for Request falls out of that process be the representation — do not work toward a predetermined answer. When done, document **why** the chosen mechanism was the natural choice. That "why" is the finding that answers question 3. Do not pre-commit.

---

## `server.fit` — End-to-end program

**Shape:** Single request handler that receives an HTTP request, validates it, looks up the requested path as a file, and responds with the file contents. ~50–100 lines including re-declared type definitions.

**Skeleton:**
```fit
// All three type declarations re-included inline

fn serve_request(conn: lend HttpConn) using Net, Fs -> Result<(), HttpError> {
    let req     = http_receive(conn)?
    let req     = validate(req)?
    let path    = request_path(req)      // free function accessor; field access (req.path) is not in FIT syntax
    let f       = open(path)?
    let content = read_to_string(f)?
    // If read_to_string infers as lend: f is still owned here; close explicitly below.
    // If read_to_string infers as move: f is already consumed; omit close(f).
    // The probe resolves which is correct. Adjust accordingly.
    close(f)?
    let resp    = ok_response(content)   // free function; Response::ok() syntax does not exist in FIT
    http_send(conn, resp)?
    Ok(())
}

fn main() using Net, Fs -> Result<(), HttpError> {
    let conn = http_accept()?
    serve_request(conn)?
    http_close(conn)?
    Ok(())
}
```

Note: `request_path` and `ok_response` must be declared as externs in the re-declared type block. FIT has no field-access syntax (`req.path` does not parse) and no namespace constructors (`Response::ok()` does not parse). All accessors and constructors are free functions.

The program exercises: `File` open/read/close, `HttpConn` accept/receive/send/close, Request validation, capabilities (`Fs`, `Net`), and error propagation via `?` with implicit cleanup on early return. All three types interact.

---

## What to measure

### Metric 1 — Bodied-vs-extern ratio

For each `.fit` file, count:
- (a) Functions with FIT bodies
- (b) Extern (body-less) function declarations

Ratio = (a) / (a + b). Signal thresholds from the probe charter:
- ≥80% bodied → no-sigil differentiator survives at real scale
- ≤50% bodied → degradation is real and worth naming

Report per-type and overall.

### Metric 2 — Annotation count at the FFI surface

Total `move` + `lend` annotations written across all extern signatures. Pair with Metric 1 to compute annotation cost per externally-facing operation.

### Metric 3 — Lines of FIT-bodied orchestration vs. extern declaration

Count lines inside `fn { ... }` bodies vs. bare `fn ...` extern declaration lines. If bodies are short and externs are many, FIT is a thin C wrapper. If bodies do real orchestration (multi-step, error handling, branching), the language has expressive room.

### Qualitative observations (for the findings doc)

- **Did the model break?** For each type: did you have to invent something not in FIT-SPEC-v2.md or FIT-SYNTAX.md to make it work? If yes, which thing and why.
- **Half-shutdown honest answer:** Did `TcpSocket<HalfClosed>` fit cleanly or expose a gap? Did the directional-info loss matter in practice?
- **Validation-typestate honest answer (question 3):** What representation did Request take? Why was that the natural choice? Honest yes/no on whether typestate emerged for this — and if it didn't, what mechanism did instead?
- **What was awkward?** Specific things fought with during implementation. These are differentiator-cost evidence.
- **Bearing on differentiators #2 and #3:** Does the bodied/extern ratio show the no-sigil lending differentiator survives at real FFI surface area? Does auto-cleanup behave correctly across all three types? Report evidence for or against each differentiator surviving contact with reality.
- **PoC limitations encountered:** List each limitation from `docs/poc-findings.md` that surfaced, with the workaround used. Do not fix them — document them.

---

## Deliverables

1. `tests/stdlib-probe/file.fit` — passes checker
2. `tests/stdlib-probe/tcp.fit` — passes checker
3. `tests/stdlib-probe/http.fit` — passes checker
4. `tests/stdlib-probe/server.fit` — passes checker (standalone, types re-declared inline)
5. `docs/stdlib-probe-findings.md` — three quantitative metrics + qualitative observations per type + honest answer on validation-typestate + bearing on differentiators #2 and #3 + list of PoC limitations encountered with workarounds

---

## Escalation triggers (stop and flag, do not implement around)

1. A resource type doesn't fit the model and cannot be expressed without inventing a rule not present in FIT-SPEC-v2.md or FIT-SYNTAX.md.
2. A fourth type feels necessary to make the program work.
3. The annotation surface exceeds 50% of all signatures even with bodied orchestration.
4. The `TcpSocket` half-shutdown probe requires inventing a new spec rule (not just a new typestate variant) to resolve the gap cleanly.

Any of these is a finding, not a failure.

---

## What's out of scope

- A usable stdlib (3 types, not 30)
- Codegen or runtime testing
- Performance (C stubs can be no-ops)
- Documentation polish beyond the findings doc
- Fixing any PoC limitations encountered — note them, work around with explicit annotations, do not fix

---

## Known PoC limitations that may surface

The PoC findings doc (`docs/poc-findings.md`) lists these limitations. If any appear during the probe, note them with the workaround used:

- **Self-recursive inference gap** — self-recursive functions must carry explicit annotation on consumed resource params
- **Stored-into-aggregate gap** — functions storing resources into collections need explicit annotation
- **Match variant payload types** — linear values inside enum variants not tracked
- **`Ok(call_expr)` not consumed** — only `Ok(named_var)` triggers consumption tracking
- **Nested linear resources** — `HttpConn` contains `sock: TcpSocket` (a linear field inside a resource). The checker treats the outer resource as a whole and does not verify that the inner linear field is consumed when the outer resource is consumed. This is the stored-into-aggregate gap at the field level. Workaround: ensure `http_force_close` and `http_close` carry explicit `move` annotations and trust that the C stub handles socket teardown. Note: the field is declared as `TcpSocket` (un-parameterized) rather than `TcpSocket<Connected>` — the current parser is untested on parameterized resource types as field types and likely does not support that syntax.
- **Field access not supported** — FIT has no `record.field` access syntax. All field reads must be expressed as free function calls (`request_path(req)` not `req.path`). These free functions must be declared as externs.
