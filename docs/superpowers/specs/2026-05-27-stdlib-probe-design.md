# FIT — Standard Library Design Probe Spec

**Date:** 2026-05-27
**Status:** Approved, ready for implementation

---

## Purpose

This probe tests two questions that the PoC and codegen spike could not answer:

1. **How thick is the FFI extern surface in real resource types?** The no-sigil lending differentiator degrades at the FFI boundary. This probe measures whether real resource types — where FFI is only the bottom shim and orchestration is FIT-bodied — produce an acceptable bodied-vs-extern ratio.

2. **Do real resource types fit the resource + typestate model?** The probe stresses three types with different shapes, including the half-shutdown edge case and the validation-typestate hypothesis.

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
└── server.fit    # End-to-end program using all three types (~50–80 lines)
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

fn open(path: String) -> Result<File, IoError>
fn read(f: lend File, buf: lend Bytes) -> Result<Int, IoError>
fn write(f: lend File, data: Bytes) -> Result<Int, IoError>
fn seek(f: lend File, pos: Int) -> Result<(), IoError>
fn close(f: move File) -> Result<(), IoError>
```

**Bodied orchestration:**
```fit
fn read_to_string(f: File) -> Result<String, IoError> {
    let mut buf = Bytes::empty()
    read(f, buf)?
    Ok(String::from_bytes(buf))
}
```

**Key question to observe:** Does `read_to_string` correctly infer lend (caller retains `f` after call) because the body only passes `f` to a lending callee? On the error path (`read` fails), `f` is still owned — auto-cleanup fires. The move/lend story should work naturally here.

---

## Type 2 — `TcpSocket<S>` (`tcp.fit`)

**Shape:** Typestate-driven linear resource. Progression: `Fresh → Connected → Closing`. Half-shutdown modeled honestly.

**Half-shutdown approach:** Attempt to express half-shutdown as `TcpSocket<HalfClosed>`. The expected awkwardness: `tcp_shutdown(dir: Direction)` produces the same `TcpSocket<HalfClosed>` regardless of direction, losing the read/write distinction. Report whether this matters in practice and whether the directional-info loss is an acceptable simplification or a genuine model break.

**Extern shims:**
```fit
enum TcpState { Fresh, Connected, HalfClosed, Closing }

resource TcpSocket<S> {
    fd:      SocketFd,
    cleanup: tcp_force_close,
}

enum NetError { Refused, Timeout, Reset, BrokenPipe }
enum Direction { Read, Write }

fn tcp_connect(addr: String, port: Int) -> Result<TcpSocket<Connected>, NetError>
fn tcp_send(s: lend TcpSocket<Connected>, data: Bytes) -> Result<Int, NetError>
fn tcp_recv(s: lend TcpSocket<Connected>, buf: lend Bytes) -> Result<Int, NetError>
fn tcp_shutdown(s: move TcpSocket<Connected>, dir: Direction) -> Result<TcpSocket<HalfClosed>, NetError>
fn tcp_close(s: move TcpSocket<Connected>) -> Result<TcpSocket<Closing>, NetError>
fn tcp_finish(s: move TcpSocket<Closing>) -> Result<(), NetError>
fn tcp_force_close(s: move TcpSocket<HalfClosed>) -> ()
```

**Bodied orchestration:**
```fit
fn tcp_roundtrip(s: lend TcpSocket<Connected>, req: Bytes) -> Result<Bytes, NetError> {
    tcp_send(s, req)?
    let mut buf = Bytes::empty()
    tcp_recv(s, buf)?
    Ok(buf)
}
```

**What to observe:** Does `TcpSocket<HalfClosed>` feel like a natural state in the progression, or does it feel like a workaround? Is the directional-info loss (can't distinguish read-half-closed from write-half-closed) a real problem or a non-issue for typical usage? Report honestly.

---

## Type 3 — `HttpConn` (`http.fit`)

**Shape:** Composite resource built on `TcpSocket<Connected>`. The Request representation is **not pre-decided** — write `HttpConn` starting from what HTTP protocol operations actually need, and let the mechanism for Request (resource with typestate, two distinct records, or something else) fall out naturally. Document *why* the chosen mechanism was the natural choice. That "why" is the finding.

**What HTTP actually needs:** receive bytes from connection → parse into structured request → validate fields → dispatch to handler that requires a validated request → send response.

**Scaffolding to start from:**
```fit
resource HttpConn {
    sock:    TcpSocket<Connected>,
    cleanup: http_force_close,
}

enum HttpError { BadRequest, NotFound, InternalError }
type ValidationError = HttpError     // or a distinct enum — let it emerge

// Operations to define honestly:
//   http_accept() -> Result<HttpConn, NetError>
//   http_receive(conn) -> Result<???, HttpError>     // what does ??? look like?
//   validate(req: ???) -> Result<???, ValidationError>
//   handle(req: ???) using Fs -> Result<Response, HttpError>
//   http_send(conn, resp) -> Result<(), HttpError>
//   http_close(conn) -> Result<(), HttpError>
```

**The validation-typestate probe:** If writing `http.fit` honestly produces `Request<Raw>` and `Request<Validated>` as a resource with typestate — and it feels natural, not invented — that is evidence for the "second pillar" hypothesis. If it produces two distinct record types (`ParsedRequest` / `ValidatedRequest`) with no typestate involved — and *that* feels natural — the finding is that distinct types achieve the same safety guarantee more simply than typestate, and the second pillar is not a novel FIT feature but ordinary type safety.

**Do not pre-commit to either outcome.** Build it, then report.

---

## `server.fit` — End-to-end program

**Shape:** Single request handler that receives an HTTP request, validates it, looks up the requested path as a file, and responds with the file contents. ~50–80 lines including re-declared type definitions.

**Skeleton:**
```fit
// All three type declarations re-included inline

fn serve_request(conn: lend HttpConn) using Fs -> Result<(), HttpError> {
    let req     = http_receive(conn)?
    let req     = validate(req)?
    let path    = req.path
    let f       = open(path)?
    let content = read_to_string(f)?
    close(f)?
    let resp    = Response::ok(content)
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

- **Did the model break?** For each type: did you have to invent something not in the spec to make it work? If yes, what and why.
- **Half-shutdown honest answer:** Did `TcpSocket<HalfClosed>` fit cleanly or expose a gap?
- **Validation-typestate honest answer:** Did typestate emerge naturally for Request, or did distinct types do the job? Why?
- **What was awkward?** Things you fought with. These are differentiator-cost evidence.

---

## Deliverables

1. `tests/stdlib-probe/file.fit` — passes checker
2. `tests/stdlib-probe/tcp.fit` — passes checker
3. `tests/stdlib-probe/http.fit` — passes checker
4. `tests/stdlib-probe/server.fit` — passes checker (standalone, types re-declared inline)
5. `docs/stdlib-probe-findings.md` — three quantitative metrics + qualitative observations per type + honest answer on validation-typestate + bearing on differentiators #2 and #3

---

## Escalation triggers (stop and flag, do not implement around)

1. A resource type doesn't fit the model and cannot be expressed without inventing new spec rules.
2. A fourth type feels necessary to make the program work.
3. The annotation surface exceeds 50% of all signatures even with bodied orchestration.
4. The `TcpSocket` half-shutdown reveals a spec gap that propagates into `HttpConn`.

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
- **Nested linear resources** — `HttpConn` contains `sock: TcpSocket<Connected>` (a linear field inside a resource). The checker treats the outer resource as a whole and does not verify that the inner linear field is consumed when the outer resource is consumed. This is the stored-into-aggregate gap at the field level. Workaround: ensure `http_force_close` and `http_close` carry explicit `move` annotations and trust that the C stub handles socket teardown.
