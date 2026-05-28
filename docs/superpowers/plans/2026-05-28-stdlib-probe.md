# FIT Standard Library Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write three FIT resource types (`File`, `TcpSocket<S>`, `HttpConn`) and one end-to-end program to probe FFI surface thickness, typestate model fitness, and the validation-typestate hypothesis.

**Architecture:** Each type is written as a standalone `.fit` file, independently checked by the existing FIT checker. `server.fit` re-declares all types inline. The probe produces three quantitative metrics and qualitative findings per type. No TypeScript source is modified — only `.fit` files and a findings document are written.

**Tech Stack:** FIT language (`.fit` files), existing checker at `node dist/src/main.js check <file>`, git.

**Spec:** `docs/superpowers/specs/2026-05-27-stdlib-probe-design.md`

---

## Measurement tracking

Fill this table in as you complete each type task. The findings document (Task 6) is built from it.

| Metric | file.fit | tcp.fit | http.fit | Total |
|--------|----------|---------|----------|-------|
| Bodied functions (fn with `{ }`) | | | | |
| Extern declarations (fn without `{ }`) | | | | |
| Bodied / total ratio | | | | |
| `move` annotations on externs | | | | |
| `lend` annotations on externs | | | | |
| Total annotations | | | | |
| Lines inside `fn { }` bodies | | | | |
| Lines of bare `fn ...` extern declarations | | | | |

---

## Task 1: Set up directory and verify checker

**Files:**
- Create: `tests/stdlib-probe/` (directory)

- [ ] **Step 1: Create the directory**

```bash
mkdir -p /Users/kofi/_/fit/tests/stdlib-probe
```

- [ ] **Step 2: Verify the checker works on an existing file**

```bash
node /Users/kofi/_/fit/dist/src/main.js check /Users/kofi/_/fit/tests/payment.fit
echo "exit: $?"
```

Expected: no output, `exit: 0`. If the checker fails, run `npm run build` from `/Users/kofi/_/fit` first, then retry.

---

## Task 2: Write and check `file.fit`

**Files:**
- Create: `tests/stdlib-probe/file.fit`

**Background:** `File` is the control case — linear resource, no typestate. If it doesn't fit cleanly, the model is broken at the simplest level. The key measurement question is whether `read_to_string` is inferred as lend (caller retains `f`) or move (caller loses `f`). This has direct ergonomic consequences for the "open → read → close" usage pattern.

- [ ] **Step 1: Write `file.fit`**

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

fn read_to_string(f: File) -> Result<String, IoError> {
    let buf = empty_bytes()
    read(f, buf)?
    Ok(bytes_to_string(buf))
}
```

- [ ] **Step 2: Run the checker**

```bash
node /Users/kofi/_/fit/dist/src/main.js check /Users/kofi/_/fit/tests/stdlib-probe/file.fit
echo "exit: $?"
```

Expected: no output, `exit: 0`. If you get errors, record them in the findings notes and fix the `.fit` file. Do not change the checker source.

- [ ] **Step 3: Answer the lend/move inference question**

The body of `read_to_string` only passes `f` to `read(f, buf)` — a lending callee. By the spec's body-based inference rule, `f` should be classified as LEND. This means the checker accepts the call without errors, and the caller retains ownership of `f` after the function returns (including on the error path — cleanup of `f` is the caller's responsibility there).

To verify: create a temporary test file to confirm the checker's classification in practice.

Write `/Users/kofi/_/fit/tests/stdlib-probe/file_usage_test.fit` (delete after checking):

```fit
resource File {
    handle:  FileHandle,
    cleanup: force_close,
}

enum IoError { NotFound, PermissionDenied, BrokenPipe }

fn open(path: String) using Fs -> Result<File, IoError>
fn read(f: lend File, buf: lend Bytes) using Fs -> Result<Int, IoError>
fn close(f: move File) using Fs -> Result<(), IoError>
fn empty_bytes() -> Bytes
fn bytes_to_string(buf: Bytes) -> String

fn read_to_string(f: File) -> Result<String, IoError> {
    let buf = empty_bytes()
    read(f, buf)?
    Ok(bytes_to_string(buf))
}

// If read_to_string infers LEND: f is still available after the call → close(f) is valid
// If read_to_string infers MOVE: f is consumed → close(f) would be use-after-move error
fn test_usage(path: String) using Fs -> Result<String, IoError> {
    let f = open(path)?
    let content = read_to_string(f)?
    close(f)?
    Ok(content)
}
```

```bash
node /Users/kofi/_/fit/dist/src/main.js check /Users/kofi/_/fit/tests/stdlib-probe/file_usage_test.fit
echo "exit: $?"
```

- If exit 0: `read_to_string` inferred as **LEND** — caller retains `f`; ergonomic pattern is `open → read_to_string → close` (3 steps). Record this.
- If the checker errors on `close(f)?` with a use-after-move: `read_to_string` inferred as **MOVE** — caller loses `f`; ergonomic pattern is `open → read_to_string` (2 steps, cleanup implicit). Record this and adjust the `server.fit` skeleton in Task 5.

Delete the test file after noting the result:

```bash
rm /Users/kofi/_/fit/tests/stdlib-probe/file_usage_test.fit
```

- [ ] **Step 4: Record file.fit measurements in the tracking table above**

Count from the final `file.fit` content:
- Bodied functions: 1 (`read_to_string`)
- Extern declarations: 7 (`open`, `read`, `write`, `seek`, `close`, `empty_bytes`, `bytes_to_string`)
- Bodied/total ratio: 1/8 = 12.5%
- `lend` annotations on externs: 4 (`read` has `f: lend File` and `buf: lend Bytes`; `write` has `f: lend File`; `seek` has `f: lend File` — count each annotation separately)
- `move` annotations on externs: 1 (`close` has `f: move File`)
- Total annotations: 5
- Lines inside `fn { }` bodies: 3 (`let buf = empty_bytes()`, `read(f, buf)?`, `Ok(bytes_to_string(buf))`)
- Lines of bare extern declarations: 7 (one per extern `fn` without a body)

Update the measurement tracking table at the top of this plan.

- [ ] **Step 5: Commit**

```bash
git -C /Users/kofi/_/fit add tests/stdlib-probe/file.fit
git -C /Users/kofi/_/fit commit -m "probe: add file.fit — File resource type (control case)"
```

---

## Task 3: Write and check `tcp.fit`

**Files:**
- Create: `tests/stdlib-probe/tcp.fit`

**Background:** `TcpSocket<S>` introduces typestate. The progression is `Fresh → Connected → Closing`. The half-shutdown probe adds `HalfClosed` as a typestate variant and tests whether a single `HalfClosed` state (losing the read/write direction distinction) is a workable simplification or a genuine model break.

- [ ] **Step 1: Write `tcp.fit`**

```fit
enum TcpState { Fresh, Connected, HalfClosed, Closing }

resource TcpSocket<S> {
    fd:      SocketFd,
    cleanup: tcp_force_close,
}

// tcp_force_close is an infallible C function that handles any socket state at scope exit.
// It is the cleanup label — do not add a typed fn declaration for it here.

enum NetError { Refused, Timeout, Reset, BrokenPipe }
enum Direction { Read, Write }

fn tcp_socket() using Net -> Result<TcpSocket<Fresh>, NetError>
fn tcp_connect(s: move TcpSocket<Fresh>, addr: String, port: Int) using Net -> Result<TcpSocket<Connected>, NetError>
fn tcp_send(s: lend TcpSocket<Connected>, data: Bytes) using Net -> Result<Int, NetError>
fn tcp_recv(s: lend TcpSocket<Connected>, buf: lend Bytes) using Net -> Result<Int, NetError>
fn tcp_shutdown(s: move TcpSocket<Connected>, dir: Direction) using Net -> Result<TcpSocket<HalfClosed>, NetError>
fn tcp_close(s: move TcpSocket<Connected>) using Net -> Result<TcpSocket<Closing>, NetError>
fn tcp_finish(s: move TcpSocket<Closing>) using Net -> Result<(), NetError>

fn tcp_roundtrip(s: lend TcpSocket<Connected>, req: Bytes, buf: lend Bytes) using Net -> Result<Bytes, NetError> {
    tcp_send(s, req)?
    tcp_recv(s, buf)?
    Ok(buf)
}
```

- [ ] **Step 2: Run the checker**

```bash
node /Users/kofi/_/fit/dist/src/main.js check /Users/kofi/_/fit/tests/stdlib-probe/tcp.fit
echo "exit: $?"
```

Expected: no output, `exit: 0`. Record any errors as probe findings.

- [ ] **Step 3: Assess the half-shutdown finding**

After the checker passes, answer these questions in your notes (these go into the findings doc):

1. Does `TcpSocket<HalfClosed>` feel like a natural extension of the `Fresh → Connected → Closing` progression, or does it feel bolted on?
2. `tcp_shutdown(dir: Direction)` produces `TcpSocket<HalfClosed>` regardless of whether `dir` is `Read` or `Write`. Does losing this directional distinction matter for the types of programs FIT is targeting, or is it a non-issue in practice?
3. Did the model require any spec rule not present in FIT-SPEC-v2.md or FIT-SYNTAX.md to express this type? (If yes: escalate — do not continue.)

- [ ] **Step 4: Record tcp.fit measurements in the tracking table above**

Count from the final `tcp.fit` content:
- Bodied functions: 1 (`tcp_roundtrip`)
- Extern declarations: 7 (`tcp_socket`, `tcp_connect`, `tcp_send`, `tcp_recv`, `tcp_shutdown`, `tcp_close`, `tcp_finish`)
- Bodied/total ratio: 1/8 = 12.5%
- `lend` annotations on externs: 3 (`tcp_send` has `s: lend TcpSocket<Connected>`; `tcp_recv` has `s: lend TcpSocket<Connected>` and `buf: lend Bytes`)
- `move` annotations on externs: 4 (`tcp_connect` has `s: move TcpSocket<Fresh>`; `tcp_shutdown` has `s: move TcpSocket<Connected>`; `tcp_close` has `s: move TcpSocket<Connected>`; `tcp_finish` has `s: move TcpSocket<Closing>`)
- Total annotations: 7
- Lines inside `fn { }` bodies: 3 (`tcp_send(s, req)?`, `tcp_recv(s, buf)?`, `Ok(buf)`)
- Lines of bare extern declarations: 7

Update the measurement tracking table.

- [ ] **Step 5: Commit**

```bash
git -C /Users/kofi/_/fit add tests/stdlib-probe/tcp.fit
git -C /Users/kofi/_/fit commit -m "probe: add tcp.fit — TcpSocket<S> with typestate and half-shutdown"
```

---

## Task 4: Write and check `http.fit` (discovery task)

**Files:**
- Create: `tests/stdlib-probe/http.fit`

**Background:** This is the probe's discovery task. The Request representation (resource with typestate, two distinct record types, or something else) is NOT pre-decided. Write from what HTTP's operations actually need, let the mechanism emerge, then record why it was the natural choice. That "why" is the answer to probe question 3.

- [ ] **Step 1: Write the fixed scaffolding (known ahead of time)**

Start `http.fit` with this content — this part is not in question:

```fit
resource HttpConn {
    sock:    TcpSocket,
    cleanup: http_force_close,
}

enum HttpError { BadRequest, NotFound, InternalError }
enum NetError  { Refused, Timeout, Reset, BrokenPipe }
```

- [ ] **Step 2: Decide the Request representation by writing from HTTP's operations**

Work through these four operations in order. For each, write what you need and what it implies:

**Operation A — `http_receive`:** This reads raw bytes from the socket and parses them into a structured HTTP request. What does it return? It returns "a request." Ask: does this request thing hold any OS resources (file descriptors, socket references that need cleanup)? Or is it just data (method string, path string, body bytes)?

- If it holds OS resources: it must be a `resource` type (linear, with cleanup). That means `Request` is a resource.
- If it's pure data: it can be a `record` type (unrestricted, no cleanup). That means `Request` is a record.

Write `http_receive` with whatever return type you conclude is natural.

**Operation B — `validate`:** This takes the parsed request and produces a validated one. What does it accept? What does it return? Can the return type be different from the input type (two distinct types)? Or does it transform state (typestate on a resource)?

- If two distinct types: `fn validate(req: ParsedRequest) -> Result<ValidatedRequest, HttpError>`
- If typestate: `fn validate(req: move Request<Raw>) -> Result<Request<Validated>, HttpError>`
- Write whichever fell out of Operation A naturally.

**Operation C — `http_send`:** Sends a response back on the connection. Takes `conn: lend HttpConn` and `resp: Response`. Nothing about Request is involved here. Write it.

**Operation D — `http_close`:** Closes the connection. Consumes it. Write it.

After writing all four operations, add `http_accept()` as the factory that creates `HttpConn`.

**Write the complete `http.fit` from what emerged.** A plausible complete file looks like one of these shapes — write whichever is honest:

Shape A (two distinct records — if Request is pure data):
```fit
resource HttpConn {
    sock:    TcpSocket,
    cleanup: http_force_close,
}

enum HttpError { BadRequest, NotFound, InternalError }
enum NetError  { Refused, Timeout, Reset, BrokenPipe }

record ParsedRequest {
    method: String,
    path:   String,
    body:   Bytes,
}

record ValidatedRequest {
    method: String,
    path:   String,
    body:   Bytes,
}

fn http_accept() using Net -> Result<HttpConn, NetError>
fn http_receive(conn: lend HttpConn) using Net -> Result<ParsedRequest, HttpError>
fn validate(req: ParsedRequest) -> Result<ValidatedRequest, HttpError>
fn request_path(req: ValidatedRequest) -> String
fn ok_response(body: String) -> Response
fn http_send(conn: lend HttpConn, resp: Response) using Net -> Result<(), HttpError>
fn http_close(conn: move HttpConn) using Net -> Result<(), HttpError>
fn http_force_close(conn: move HttpConn) -> ()
```

Shape B (resource with typestate — if Request is linear and has cleanup):
```fit
resource HttpConn {
    sock:    TcpSocket,
    cleanup: http_force_close,
}

enum RequestState { Raw, Validated }

resource Request<S> {
    method:  String,
    path:    String,
    body:    Bytes,
    cleanup: discard_request,
}

enum HttpError { BadRequest, NotFound, InternalError }
enum NetError  { Refused, Timeout, Reset, BrokenPipe }

fn http_accept() using Net -> Result<HttpConn, NetError>
fn http_receive(conn: lend HttpConn) using Net -> Result<Request<Raw>, HttpError>
fn validate(req: move Request<Raw>) -> Result<Request<Validated>, HttpError>
fn request_path(req: lend Request<Validated>) -> String
fn ok_response(body: String) -> Response
fn http_send(conn: lend HttpConn, resp: Response) using Net -> Result<(), HttpError>
fn http_close(conn: move HttpConn) using Net -> Result<(), HttpError>
fn http_force_close(conn: move HttpConn) -> ()
fn discard_request(req: move Request<Raw>) -> ()
```

Write whichever shape honestly describes what HTTP operations need. If a third shape emerged that isn't either of these, write that instead.

- [ ] **Step 3: Run the checker**

```bash
node /Users/kofi/_/fit/dist/src/main.js check /Users/kofi/_/fit/tests/stdlib-probe/http.fit
echo "exit: $?"
```

Expected: `exit: 0`. Fix any checker errors in the `.fit` file (not the checker source). Record errors as probe findings if they reveal something interesting about the model.

- [ ] **Step 4: Answer question 3 — the validation-typestate finding**

Write your honest answer to these in your notes. These go verbatim into the findings document:

1. **What representation did Request take?** (Record type, resource with typestate, or other?)
2. **Why was that the natural choice?** (What about HTTP's operations drove the decision?)
3. **Did typestate emerge for Request?** (Yes/no — not a success criterion either way)
4. **If typestate did NOT emerge:** Is the safety guarantee achieved another way? (Two distinct types = type safety, not typestate — note the distinction.)
5. **If typestate DID emerge:** Was the cleanup on `Request` meaningful, or was it a no-op invented to satisfy the `resource` declaration?

- [ ] **Step 5: Record http.fit measurements in the tracking table above**

Count bodied functions, extern declarations, ratio, annotations, and lines. Update the table.

- [ ] **Step 6: Commit**

```bash
git -C /Users/kofi/_/fit add tests/stdlib-probe/http.fit
git -C /Users/kofi/_/fit commit -m "probe: add http.fit — HttpConn composite type, Request representation discovered"
```

---

## Task 5: Write and check `server.fit`

**Files:**
- Create: `tests/stdlib-probe/server.fit`

**Background:** `server.fit` is a standalone checkable program that exercises all three types end-to-end. It re-declares all needed type definitions inline (FIT has no module system). The exact content depends on findings from Tasks 2–4: whether `read_to_string` infers lend or move, and what `Request` type emerged. Adjust the marked lines accordingly.

- [ ] **Step 1: Write `server.fit` with all types re-declared inline**

Use the findings from Tasks 2–4 to fill in the sections marked `[ADJUST]`.

```fit
// ── File type (from file.fit) ────────────────────────────────────────────────

resource File {
    handle:  FileHandle,
    cleanup: force_close,
}

enum IoError { NotFound, PermissionDenied, BrokenPipe }

fn open(path: String) using Fs -> Result<File, IoError>
fn read(f: lend File, buf: lend Bytes) using Fs -> Result<Int, IoError>
fn close(f: move File) using Fs -> Result<(), IoError>
fn empty_bytes() -> Bytes
fn bytes_to_string(buf: Bytes) -> String

fn read_to_string(f: File) -> Result<String, IoError> {
    let buf = empty_bytes()
    read(f, buf)?
    Ok(bytes_to_string(buf))
}

// ── TcpSocket type (from tcp.fit) ───────────────────────────────────────────

enum TcpState { Fresh, Connected, HalfClosed, Closing }

resource TcpSocket<S> {
    fd:      SocketFd,
    cleanup: tcp_force_close,
}

enum NetError { Refused, Timeout, Reset, BrokenPipe }

// ── HttpConn type (from http.fit) ────────────────────────────────────────────

resource HttpConn {
    sock:    TcpSocket,
    cleanup: http_force_close,
}

enum HttpError { BadRequest, NotFound, InternalError }

// [ADJUST] Re-declare the Request type exactly as it appeared in http.fit.
// If two distinct records:
//   record ParsedRequest { method: String, path: String, body: Bytes }
//   record ValidatedRequest { method: String, path: String, body: Bytes }
// If resource with typestate:
//   enum RequestState { Raw, Validated }
//   resource Request<S> { method: String, path: String, body: Bytes, cleanup: discard_request }
//   fn discard_request(req: move Request<Raw>) -> ()

// [ADJUST] Re-declare http.fit externs that server.fit calls.
// Copy them verbatim from http.fit. At minimum:
fn http_accept() using Net -> Result<HttpConn, NetError>
// fn http_receive(conn: lend HttpConn) using Net -> Result<???, HttpError>
// fn validate(req: ???) -> Result<???, HttpError>
// fn request_path(req: ???) -> String
fn ok_response(body: String) -> Response
fn http_send(conn: lend HttpConn, resp: Response) using Net -> Result<(), HttpError>
fn http_close(conn: move HttpConn) using Net -> Result<(), HttpError>

// ── End-to-end program ───────────────────────────────────────────────────────

fn serve_request(conn: lend HttpConn) using Net, Fs -> Result<(), HttpError> {
    let req     = http_receive(conn)?
    let req     = validate(req)?
    let path    = request_path(req)
    let f       = open(path)?
    let content = read_to_string(f)?
    // [ADJUST] If read_to_string inferred LEND (Task 2, Step 3): keep close(f)? below.
    // If read_to_string inferred MOVE: delete close(f)? — f is already consumed.
    close(f)?
    let resp    = ok_response(content)
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

- [ ] **Step 2: Run the checker**

```bash
node /Users/kofi/_/fit/dist/src/main.js check /Users/kofi/_/fit/tests/stdlib-probe/server.fit
echo "exit: $?"
```

Expected: `exit: 0`. Fix any errors by adjusting the `.fit` declarations. If an error reveals a genuine model gap (something that requires inventing a new spec rule), record it and escalate — do not work around by patching the checker.

Known errors to watch for and how to handle:
- **`extern 'X' has linear parameter 'Y' with no move/lend annotation`** — add the missing annotation to the extern declaration
- **`value 'f' has already been moved`** on `close(f)?` — `read_to_string` inferred MOVE; remove `close(f)?`
- **`missing capability 'X' required by 'fn'`** — add `using X` to the calling function's signature

- [ ] **Step 3: Commit**

```bash
git -C /Users/kofi/_/fit add tests/stdlib-probe/server.fit
git -C /Users/kofi/_/fit commit -m "probe: add server.fit — end-to-end program using all three types"
```

---

## Task 6: Write `docs/stdlib-probe-findings.md`

**Files:**
- Create: `docs/stdlib-probe-findings.md`

**Background:** Compile all measurements and qualitative observations into the findings document. This is the probe's primary deliverable. Use the measurement table filled in during Tasks 2–4.

- [ ] **Step 1: Write the findings document**

Create `docs/stdlib-probe-findings.md` with the following structure, filling in each section with actual measurements and honest observations:

```markdown
# FIT — Standard Library Probe Findings

**Date:** 2026-05-28
**Spec:** docs/superpowers/specs/2026-05-27-stdlib-probe-design.md
**Checker:** all four .fit files pass `node dist/src/main.js check` with exit 0

---

## Quantitative metrics

### Metric 1 — Bodied-vs-extern ratio

| File | Bodied fns | Extern fns | Total | Ratio |
|------|-----------|-----------|-------|-------|
| file.fit | | | | |
| tcp.fit | | | | |
| http.fit | | | | |
| **Total** | | | | |

**Signal:** ≥80% bodied → no-sigil differentiator survives. ≤50% bodied → degradation is real.
**Finding:** [Write 1–2 sentences interpreting the ratio.]

### Metric 2 — Annotation count at the FFI surface

| File | `move` annotations | `lend` annotations | Total | Externs | Annotations/extern |
|------|-------------------|-------------------|-------|---------|-------------------|
| file.fit | | | | | |
| tcp.fit | | | | | |
| http.fit | | | | | |
| **Total** | | | | | |

**Finding:** [Write 1–2 sentences interpreting the annotation cost.]

### Metric 3 — Lines of FIT-bodied orchestration vs. extern declarations

| File | Lines in `fn { }` bodies | Lines of bare `fn ...` externs | Body/extern ratio |
|------|--------------------------|-------------------------------|-------------------|
| file.fit | | | |
| tcp.fit | | | |
| http.fit | | | |
| **Total** | | | |

**Finding:** [Write 1–2 sentences — is FIT doing real work, or is it a thin C wrapper?]

---

## Qualitative findings

### Did the model break?

For each type: did expressing it require inventing anything not in FIT-SPEC-v2.md or FIT-SYNTAX.md?

- **File:** [Yes/No. If yes: what and why.]
- **TcpSocket:** [Yes/No. If yes: what and why.]
- **HttpConn:** [Yes/No. If yes: what and why.]

### Half-shutdown finding

[Answer: Did TcpSocket<HalfClosed> fit naturally? Did the directional-info loss matter? Was this a clean simplification or a genuine model break?]

### Validation-typestate finding (probe question 3)

**What representation did Request take?** [Record type / resource with typestate / other]

**Why was that the natural choice?** [1–3 sentences on what drove the decision.]

**Did typestate emerge for data trust?** [Yes/No]

**Interpretation:** [Honest 2–3 sentence assessment. If typestate emerged naturally: evidence for the second pillar. If two distinct types emerged: note that distinct types achieve the same safety guarantee — type safety, not typestate. If something else: describe it.]

### What was awkward?

[List specific friction points encountered during implementation. These are differentiator-cost evidence. Be specific — "had to add explicit move annotation to X because Y" is more useful than "annotations were tedious."]

### Bearing on differentiators #2 and #3

**Differentiator #2 — No-sigil lending:** [Does the bodied/extern ratio show the no-sigil property survives at real FFI surface area? What fraction of functions the end programmer interacts with carry explicit annotations?]

**Differentiator #3 — Auto-cleanup:** [Did auto-cleanup behave correctly across all three types? Were there any cases where the checker failed to account for cleanup, or where cleanup fired unexpectedly?]

---

## PoC limitations encountered

| Limitation | Surfaced in | Workaround used |
|-----------|------------|----------------|
| [name from poc-findings.md] | [which .fit file] | [what you did] |

If no limitations surfaced: "No PoC limitations encountered during the probe."

---

## Summary

[3–5 sentences. What do the three quantitative metrics say together? What's the most important qualitative finding? Does the probe answer its three questions, and if so, what are the answers?]
```

- [ ] **Step 2: Verify the findings document is complete**

Check against the spec's required contents (`docs/superpowers/specs/2026-05-27-stdlib-probe-design.md`, deliverable 5):
- [ ] Three quantitative metrics with filled-in tables
- [ ] Qualitative observations per type (model break question)
- [ ] Half-shutdown honest answer
- [ ] Validation-typestate honest answer (question 3)
- [ ] Bearing on differentiators #2 and #3
- [ ] List of PoC limitations encountered with workarounds

- [ ] **Step 3: Commit**

```bash
git -C /Users/kofi/_/fit add docs/stdlib-probe-findings.md
git -C /Users/kofi/_/fit commit -m "probe: stdlib probe findings — quantitative metrics and qualitative observations"
```
