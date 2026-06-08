# FIT v0.1 Module System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal flat-namespace module system to FIT: `import filename` loads all declarations from another `.fit` file in the same directory, enables multi-file programs, and rejects cycles and duplicate names.

**Architecture:** A new `loader.ts` module sits between `main.ts` and the parser. It reads files recursively, resolves imports, deduplicates via a shared `included` set (diamond-safe), detects cycles via a call-stack array, and returns a single assembled `Program` with all `import` decls stripped. `buildTypeEnv` gains duplicate-name detection. `Pos` gains a `file` field (option a — see Task 0).

**Tech Stack:** TypeScript, Node.js `fs`/`path`, Jest for tests.

---

## ⚠️ DESIGN DECISION — Read before Task 0

The brief from O explicitly flags this as an escalation trigger: **how to track which file an error came from** when errors span multiple files. Three options:
- **(a) Add `file: string` to `Pos`** — cleanest, ripples to 2 test literal constructions  
- **(b) Keep `Pos` as-is, emit file context at the formatting layer**  
- **(c) Thread an "active file" param through loader and parser**

**This plan recommends (a).** Impact is small: only two test locations directly construct `Pos` literals (`checker.test.ts:32`, `types.test.ts:63`). All other `Pos` values come from `Parser.pos()`, which already has `this.filename`. Parser throws already embed the filename. Loader can attach absolute paths at parse time.

**If the user wants a different option, update Tasks 0–5 accordingly before running.**

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/ast.ts` | Modify | Add `file` to `Pos`; add `Decl.import` variant |
| `src/parser.ts` | Modify | Add `parseImport`; enforce imports-first ordering |
| `src/loader.ts` | **Create** | `loadProgram` — recursive resolution, memoization, cycle detection |
| `src/types.ts` | Modify | Duplicate-name detection in `buildTypeEnv` |
| `src/main.ts` | Modify | Use `loadProgram`; update `printErrors` to use `pos.file` |
| `src/codegen.ts` | Modify | Guard against accidental `import` decl leakage |
| `tests/loader.test.ts` | **Create** | Isolated loader unit tests |
| `tests/suite.test.ts` | Modify | Use `loadProgram`; filter dep files |
| `tests/checker.test.ts` | Modify | Fix `Pos` literal at line 32 |
| `tests/types.test.ts` | Modify | Fix `Pos` literal at line 63 |
| `tests/should_pass/import_basic.fit` + `_dep.fit` | **Create** | Basic two-file import |
| `tests/should_pass/import_resource_chain*.fit` | **Create** (3 files) | Transitive import chain |
| `tests/should_pass/import_variant_namespacing*.fit` | **Create** (2 files) | §2.5 still works cross-file |
| `tests/should_fail/import_duplicate_name*.fit` | **Create** (3 files) | Collision across imports |
| `tests/should_fail/import_cycle*.fit` | **Create** (2 files) | Cycle detection |
| `tests/should_fail/import_missing_file.fit` | **Create** | Missing import |
| `tests/should_fail/import_after_decl.fit` | **Create** | Import ordering violation |
| `docs/FIT-SYNTAX.md` | **Replace** | Replace with FIT-SYNTAX-v0.1.md (modules at §9) |
| `docs/poc-findings.md` | Modify | v0.1 phase log entry |

---

## Task 0: Add `file` to `Pos` (design decision prerequisite)

**Files:**
- Modify: `src/ast.ts:1`
- Modify: `src/parser.ts:75-77`
- Modify: `src/main.ts:6-9`
- Modify: `tests/checker.test.ts:32`
- Modify: `tests/types.test.ts:63`

- [ ] **Step 1: Update `Pos` type in `src/ast.ts`**

Change line 1 from:
```typescript
export type Pos = { line: number; col: number };
```
to:
```typescript
export type Pos = { line: number; col: number; file: string };
```

- [ ] **Step 2: Update `Parser.pos()` in `src/parser.ts`**

Change lines 75-77 from:
```typescript
private pos(): Pos {
  return { line: this.line, col: this.col };
}
```
to:
```typescript
private pos(): Pos {
  return { line: this.line, col: this.col, file: this.filename };
}
```

- [ ] **Step 3: Update `printErrors` in `src/main.ts`**

Change lines 6-10 from:
```typescript
function printErrors(file: string, errors: { pos: { line: number; col: number }; message: string }[]): void {
  for (const err of errors) {
    console.error(`${file}:${err.pos.line}:${err.pos.col}: ${err.message}`);
  }
}
```
to:
```typescript
function printErrors(errors: { pos: { line: number; col: number; file: string }; message: string }[]): void {
  for (const err of errors) {
    console.error(`${err.pos.file}:${err.pos.line}:${err.pos.col}: ${err.message}`);
  }
}
```

Also update all `printErrors(file, errors)` calls in `main.ts` to `printErrors(errors)`. There are two: one in the `check` branch and one in the `codegen` branch.

- [ ] **Step 4: Fix `Pos` literal in `tests/checker.test.ts:32`**

Change:
```typescript
const e: CheckError = { message: "test", pos: { line: 1, col: 1 } };
```
to:
```typescript
const e: CheckError = { message: "test", pos: { line: 1, col: 1, file: "test.fit" } };
```

- [ ] **Step 5: Fix `Pos` literal in `tests/types.test.ts:63`**

Change:
```typescript
const e: BuildError = { message: "test", pos: { line: 1, col: 1 } };
```
to:
```typescript
const e: BuildError = { message: "test", pos: { line: 1, col: 1, file: "test.fit" } };
```

- [ ] **Step 6: Run tests to confirm only TypeScript errors, not logic errors**

```bash
cd /Users/kofi/_/fit && npm test 2>&1 | head -40
```

Expected: TypeScript compilation succeeds (no `ts-jest` type errors); all existing tests still pass. The `printErrors` calls in `main.ts` will need to be updated in this step or Step 3 above — make sure both call sites are updated.

- [ ] **Step 7: Commit**

```bash
git add src/ast.ts src/parser.ts src/main.ts tests/checker.test.ts tests/types.test.ts
git commit -m "feat(pos): add file field to Pos for cross-file error attribution"
```

---

## Task 1: AST — add `Decl.import` variant

**Files:**
- Modify: `src/ast.ts:5-26`

- [ ] **Step 1: Add `import` to the `Decl` union in `src/ast.ts`**

Change the `Decl` type (starting at line 5) to add the import variant as the first member:

```typescript
export type Decl =
  | { kind: "import"; name: string; pos: Pos }
  | { kind: "capability"; name: string; pos: Pos }
  | { kind: "record"; name: string; fields: FieldDef[]; pos: Pos }
  | { kind: "enum"; name: string; variants: VariantDef[]; pos: Pos }
  | {
      kind: "resource";
      name: string;
      typeParam: string | null;
      fields: FieldDef[];
      cleanup: CleanupDef;
      pos: Pos;
    }
  | { kind: "type_alias"; name: string; members: string[]; pos: Pos }
  | {
      kind: "fn";
      name: string;
      params: ParamDef[];
      caps: string[];
      returnType: Type;
      body: Stmt[] | null;
      pos: Pos;
    };
```

- [ ] **Step 2: Run TypeScript build to confirm no type errors**

```bash
cd /Users/kofi/_/fit && npx tsc --noEmit 2>&1
```

Expected: no errors. Adding `import` to the union is additive; existing `if (decl.kind === "resource")` guards remain valid.

- [ ] **Step 3: Commit**

```bash
git add src/ast.ts
git commit -m "feat(ast): add Decl.import variant"
```

---

## Task 2: Parser — `import` form + imports-first enforcement

**Files:**
- Modify: `src/parser.ts:16` (class fields), `106-138` (parseProgram and parseDecl)
- Test: `tests/parser.test.ts` (add at end)

- [ ] **Step 1: Write failing parser tests**

Add to the end of `tests/parser.test.ts`:

```typescript
describe("import declarations", () => {
  it("parses a single import decl", () => {
    const prog = parse("import session", "root.fit");
    expect(prog.decls).toHaveLength(1);
    const d = prog.decls[0];
    expect(d.kind).toBe("import");
    if (d.kind === "import") {
      expect(d.name).toBe("session");
    }
  });

  it("parses multiple import decls before fn", () => {
    const prog = parse("import session\nimport transport\nfn run() -> ()", "root.fit");
    expect(prog.decls).toHaveLength(3);
    expect(prog.decls[0].kind).toBe("import");
    expect(prog.decls[1].kind).toBe("import");
    expect(prog.decls[2].kind).toBe("fn");
  });

  it("import after fn throws parse error", () => {
    expect(() => parse("fn foo() -> ()\nimport other", "root.fit")).toThrow(
      /import declarations must appear before/
    );
  });

  it("import records the importing file in pos", () => {
    const prog = parse("import foo", "myfile.fit");
    const d = prog.decls[0];
    if (d.kind === "import") {
      expect(d.pos.file).toBe("myfile.fit");
    }
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
cd /Users/kofi/_/fit && npm test -- --testPathPattern=parser.test 2>&1 | tail -20
```

Expected: 4 new failures (import-related tests).

- [ ] **Step 3: Add `sawNonImport` field to `Parser` class and implement `parseImport`**

In `src/parser.ts`, add `private sawNonImport = false;` to the class body (after the `filename` field, around line 22).

Change `parseDecl` (lines 116-138) to:

```typescript
private parseDecl(): Decl {
  this.skip();
  const p = this.pos();
  let kw = "";
  while (/[a-zA-Z_]/.test(this.peek())) {
    kw += this.advance();
  }
  switch (kw) {
    case "import":
      if (this.sawNonImport) {
        this.err("import declarations must appear before all other declarations");
      }
      return this.parseImport(p);
    case "record":
      this.sawNonImport = true;
      return this.parseRecord(p);
    case "enum":
      this.sawNonImport = true;
      return this.parseEnum(p);
    case "resource":
      this.sawNonImport = true;
      return this.parseResource(p);
    case "type":
      this.sawNonImport = true;
      return this.parseTypeAlias(p);
    case "capability":
      this.sawNonImport = true;
      return this.parseCapability(p);
    case "fn":
      this.sawNonImport = true;
      return this.parseFn(p);
    default:
      this.err(`unexpected top-level keyword '${kw}'`);
  }
}

private parseImport(pos: Pos): Decl {
  const name = this.ident();
  return { kind: "import", name, pos };
}
```

- [ ] **Step 4: Run tests to confirm new tests pass and no regressions**

```bash
cd /Users/kofi/_/fit && npm test -- --testPathPattern=parser.test 2>&1 | tail -20
```

Expected: all parser tests pass, including the 4 new import tests.

- [ ] **Step 5: Run full test suite**

```bash
cd /Users/kofi/_/fit && npm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/parser.ts tests/parser.test.ts
git commit -m "feat(parser): add import decl parsing with imports-first enforcement"
```

---

## Task 3: Loader — `src/loader.ts`

**Files:**
- Create: `src/loader.ts`
- Test: `tests/loader.test.ts` (write tests first)

- [ ] **Step 1: Write failing loader tests in `tests/loader.test.ts`**

Create the file:

```typescript
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { loadProgram } from "../src/loader";

describe("loader", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fit-loader-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true });
  });

  function write(name: string, src: string): string {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, src, "utf8");
    return p;
  }

  it("single file with no imports returns its decls", () => {
    const p = write("single.fit", "fn foo() -> ()");
    const { program, loadErrors } = loadProgram(p);
    expect(loadErrors).toEqual([]);
    expect(program.decls).toHaveLength(1);
    expect(program.decls[0].kind).toBe("fn");
  });

  it("dep decls appear before root decls in assembled program", () => {
    write("dep_a.fit", "fn dep_fn() -> ()");
    const root = write("root_a.fit", "import dep_a\nfn root_fn() -> ()");
    const { program, loadErrors } = loadProgram(root);
    expect(loadErrors).toEqual([]);
    expect(program.decls).toHaveLength(2);
    expect((program.decls[0] as { kind: string; name: string }).name).toBe("dep_fn");
    expect((program.decls[1] as { kind: string; name: string }).name).toBe("root_fn");
  });

  it("diamond: shared dep is included exactly once", () => {
    // Verifies memoization by outcome: if shared_b.fit were parsed and assembled twice,
    // shared_fn would appear twice in the output. One occurrence = memoization worked.
    write("shared_b.fit", "fn shared_fn() -> ()");
    write("left_b.fit", "import shared_b\nfn left_fn() -> ()");
    write("right_b.fit", "import shared_b\nfn right_fn() -> ()");
    const root = write("diamond_b.fit", "import left_b\nimport right_b\nfn root_fn() -> ()");
    const { program, loadErrors } = loadProgram(root);
    expect(loadErrors).toEqual([]);
    const names = program.decls
      .filter(d => d.kind === "fn")
      .map(d => (d as { kind: string; name: string }).name);
    const sharedOccurrences = names.filter(n => n === "shared_fn");
    expect(sharedOccurrences).toHaveLength(1);
    expect(program.decls).toHaveLength(4); // shared_fn, left_fn, right_fn, root_fn
  });

  it("cycle: emits a load error naming the cycle", () => {
    write("cycle_a_c.fit", "import cycle_b_c\nfn a() -> ()");
    const p = write("cycle_b_c.fit", "import cycle_a_c\nfn b() -> ()");
    const { loadErrors } = loadProgram(p);
    expect(loadErrors.length).toBeGreaterThan(0);
    expect(loadErrors[0].message).toMatch(/import cycle/i);
  });

  it("missing imported file: emits a load error", () => {
    const p = write("missing_root.fit", "import totally_nonexistent_xyz_999\nfn r() -> ()");
    const { loadErrors } = loadProgram(p);
    expect(loadErrors.length).toBeGreaterThan(0);
    expect(loadErrors[0].message).toMatch(/cannot read/i);
  });

  it("import decls are stripped from the assembled program", () => {
    write("stripped_dep.fit", "fn dep() -> ()");
    const root = write("stripped_root.fit", "import stripped_dep\nfn root() -> ()");
    const { program } = loadProgram(root);
    const hasImport = program.decls.some(d => d.kind === "import");
    expect(hasImport).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm tests fail (module not found)**

```bash
cd /Users/kofi/_/fit && npm test -- --testPathPattern=loader.test 2>&1 | tail -15
```

Expected: `Cannot find module '../src/loader'` errors.

- [ ] **Step 3: Implement `src/loader.ts`**

Create the file:

```typescript
import * as fs from "fs";
import * as path from "path";
import { parse } from "./parser";
import { Program, Decl, Pos } from "./ast";

export type LoadError = { message: string; pos: Pos };

export function loadProgram(
  rootPath: string
): { program: Program; loadErrors: LoadError[] } {
  const loadErrors: LoadError[] = [];
  // Files already assembled into the output — prevents re-inclusion on diamond paths
  // and also prevents re-parsing (any file in `included` was already read+parsed).
  const included = new Set<string>();

  function loadDecls(absPath: string, importPos: Pos, stack: string[]): Decl[] {
    const norm = path.resolve(absPath);

    // Cycle: file is currently being loaded in this call chain
    const cycleIdx = stack.indexOf(norm);
    if (cycleIdx !== -1) {
      const cycle = [...stack.slice(cycleIdx), norm]
        .map(p => path.basename(p))
        .join(" → ");
      loadErrors.push({ message: `import cycle detected: ${cycle}`, pos: importPos });
      return [];
    }

    // Diamond: already fully assembled in an earlier branch — skip without re-parsing
    if (included.has(norm)) return [];

    let src: string;
    try {
      src = fs.readFileSync(norm, "utf8").replace(/^﻿/, "");
    } catch {
      loadErrors.push({
        message: `cannot read '${path.basename(norm)}'`,
        pos: importPos,
      });
      return [];
    }

    let prog: Program;
    try {
      prog = parse(src, norm);
    } catch (e: unknown) {
      // Parser throws "file:line:col: message" — extract the parts so printErrors
      // doesn't double-format the location prefix.
      const raw = e instanceof Error ? e.message : String(e);
      const match = raw.match(/^(.+):(\d+):(\d+): (.+)$/s);
      if (match) {
        loadErrors.push({
          message: match[4],
          pos: { file: match[1], line: parseInt(match[2], 10), col: parseInt(match[3], 10) },
        });
      } else {
        loadErrors.push({ message: raw, pos: importPos });
      }
      return [];
    }

    // Mark included before recursing — any re-entry through a second import path
    // while this file's children are being processed hits the cycle check (via stack),
    // not the diamond check (via included), which is the correct distinction.
    included.add(norm);

    const dir = path.dirname(norm);
    const nextStack = [...stack, norm];
    const decls: Decl[] = [];

    for (const decl of prog.decls) {
      if (decl.kind === "import") {
        const depPath = path.join(dir, `${decl.name}.fit`);
        decls.push(...loadDecls(depPath, decl.pos, nextStack));
      } else {
        decls.push(decl);
      }
    }

    return decls;
  }

  const rootAbs = path.resolve(rootPath);
  const rootPos: Pos = { line: 1, col: 1, file: rootAbs };
  const decls = loadDecls(rootAbs, rootPos, []);
  return { program: { decls }, loadErrors };
}
```

- [ ] **Step 4: Run loader tests**

```bash
cd /Users/kofi/_/fit && npm test -- --testPathPattern=loader.test 2>&1 | tail -20
```

Expected: all 6 loader tests pass.

- [ ] **Step 5: Run full suite to check for regressions**

```bash
cd /Users/kofi/_/fit && npm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/loader.ts tests/loader.test.ts
git commit -m "feat(loader): add loadProgram with recursive resolution, diamond dedup, cycle detection"
```

---

## Task 4: `buildTypeEnv` — duplicate-name detection

**Files:**
- Modify: `src/types.ts:244-358` (buildTypeEnv function)

- [ ] **Step 1: Write failing type-env duplicate-detection tests**

Add to the end of `tests/types.test.ts`:

```typescript
describe("buildTypeEnv duplicate-name detection", () => {
  it("two resources with the same name in one program emits a BuildError", () => {
    const src = `
      resource Conn { cleanup: drop_conn }
      resource Conn { cleanup: drop_conn2 }
      fn drop_conn(c: move Conn) -> ()
      fn drop_conn2(c: move Conn) -> ()
    `;
    const { buildErrors } = buildTypeEnv(parse(src, "test.fit"));
    expect(buildErrors.length).toBeGreaterThan(0);
    expect(buildErrors[0].message).toMatch(/duplicate declaration of 'Conn'/);
  });

  it("two fns with the same name emits a BuildError", () => {
    const src = `
      fn foo() -> ()
      fn foo() -> ()
    `;
    const { buildErrors } = buildTypeEnv(parse(src, "test.fit"));
    expect(buildErrors.length).toBeGreaterThan(0);
    expect(buildErrors[0].message).toMatch(/duplicate declaration of 'foo'/);
  });

  it("two enums with the same name emits a BuildError", () => {
    const src = `
      enum Status { Ok }
      enum Status { Failed }
    `;
    const { buildErrors } = buildTypeEnv(parse(src, "test.fit"));
    expect(buildErrors.length).toBeGreaterThan(0);
    expect(buildErrors[0].message).toMatch(/duplicate declaration of 'Status'/);
  });

  it("two distinct top-level names produce no duplicate error", () => {
    const src = `
      resource Conn { cleanup: drop_conn }
      fn drop_conn(c: move Conn) -> ()
    `;
    const { buildErrors } = buildTypeEnv(parse(src, "test.fit"));
    const dupErrors = buildErrors.filter(e => e.message.includes("duplicate"));
    expect(dupErrors).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
cd /Users/kofi/_/fit && npm test -- --testPathPattern=types.test 2>&1 | tail -20
```

Expected: 3 new failures (duplicate detection tests).

- [ ] **Step 3: Update `buildTypeEnv` in `src/types.ts`**

Replace the `buildTypeEnv` function body. The key changes are:
1. Add `nameOrigins` Map and `checkDup` helper.
2. Wrap every `resources.set`, `aliases.set`, `enumDecls.set`, and `functions.set` with a `checkDup` guard.
3. Check capability and record decls for duplicates (they're still type-env-invisible, but duplicate names are errors).
4. Skip `import` decls silently (they should be stripped by the loader but graceful skipping is safe).
5. Remove the old `// Duplicate decl names silently last-write-win` comment.

Replace the entire `buildTypeEnv` function (lines 244–359 approximately) with:

```typescript
export function buildTypeEnv(program: Program): { env: TypeEnv; buildErrors: BuildError[] } {
  const resources = new Map<string, ResourceInfo>();
  const aliases = new Map<string, string[]>();
  const enums = new Map<string, VariantInfo[]>();
  const enumDecls = new Map<string, EnumInfo>();
  const functions = new Map<string, FunctionSig>();
  const buildErrors: BuildError[] = [];

  // Tracks the first declaration position of each top-level name for duplicate detection.
  const nameOrigins = new Map<string, Pos>();

  function checkDup(name: string, pos: Pos): boolean {
    const prior = nameOrigins.get(name);
    if (prior) {
      buildErrors.push({
        message: `duplicate declaration of '${name}' — declared in ${prior.file}:${prior.line}:${prior.col} and ${pos.file}:${pos.line}:${pos.col}`,
        pos,
      });
      return true;
    }
    nameOrigins.set(name, pos);
    return false;
  }

  // Pass 1a: resources, aliases, capabilities, records.
  // import decls should be stripped by the loader; silently skip if any leak through.
  // (Codegen uses a hard error for the same situation — here silence is intentional
  //  because type-env construction is a pure analysis pass and should degrade gracefully.)
  for (const decl of program.decls) {
    if (decl.kind === "import") continue;
    if (decl.kind === "resource") {
      if (!checkDup(decl.name, decl.pos)) {
        resources.set(decl.name, {
          name: decl.name,
          typeParam: decl.typeParam,
          cleanup: decl.cleanup.fn,
          fallback: decl.cleanup.fallback,
        });
      }
    } else if (decl.kind === "type_alias") {
      if (!checkDup(decl.name, decl.pos)) {
        aliases.set(decl.name, [...decl.members]);
      }
    } else if (decl.kind === "capability" || decl.kind === "record") {
      checkDup(decl.name, decl.pos);
    }
  }

  const resolveEnv: ResolveEnv = { resources, aliases };

  // Enum resolution pass.
  for (const decl of program.decls) {
    if (decl.kind === "enum") {
      if (checkDup(decl.name, decl.pos)) continue;
      let isLinear = false;
      for (const variant of decl.variants) {
        const payload = variant.payload !== null ? resolveType(variant.payload, resolveEnv) : null;
        const info: VariantInfo = { enumName: decl.name, payload };
        const existing = enums.get(variant.name) ?? [];
        existing.push(info);
        enums.set(variant.name, existing);
        if (payload !== null && payload.mode === "linear") isLinear = true;
      }
      enumDecls.set(decl.name, { name: decl.name, isLinear });
    }
  }

  const wideResolveEnv: WideResolveEnv = { resources, aliases, enumDecls };

  // Pass 1b: build all function signatures.
  for (const decl of program.decls) {
    if (decl.kind === "fn") {
      if (checkDup(decl.name, decl.pos)) continue;
      const returnType = resolveType(decl.returnType, wideResolveEnv);
      const params: ResolvedParam[] = decl.params.map((p) => {
        const type_ = resolveType(p.type_, wideResolveEnv);
        let mode: ParamMode;
        if (type_.mode === "linear") {
          if (p.annotatedMode !== null) {
            mode = p.annotatedMode;
          } else if (decl.body === null) {
            buildErrors.push({
              message: `extern '${decl.name}' has linear parameter '${p.name}' with no move/lend annotation`,
              pos: decl.pos,
            });
            mode = "lend";
          } else {
            mode = "lend";
          }
        } else {
          mode = "lend";
        }
        return { name: p.name, type_, mode };
      });
      functions.set(decl.name, {
        name: decl.name,
        params,
        caps: [...decl.caps],
        returnType,
      });
    }
  }

  // Pass 2: re-infer modes for bodied functions whose resource params lack explicit annotation.
  for (const decl of program.decls) {
    if (decl.kind === "fn" && decl.body !== null) {
      const sig = functions.get(decl.name);
      if (!sig) continue; // duplicate — was skipped in pass 1b
      for (let i = 0; i < sig.params.length; i++) {
        const param = sig.params[i];
        const astParam = decl.params[i];
        if (param.type_.mode === "linear" && astParam.annotatedMode === null) {
          param.mode = inferParamModeFromBody(param.name, decl.body, functions);
        }
      }
    }
  }

  return { env: { resources, aliases, enums, enumDecls, functions }, buildErrors };
}
```

- [ ] **Step 4: Run type tests**

```bash
cd /Users/kofi/_/fit && npm test -- --testPathPattern=types.test 2>&1 | tail -20
```

Expected: all tests pass including the 3 new duplicate-detection tests.

- [ ] **Step 5: Run full suite**

```bash
cd /Users/kofi/_/fit && npm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat(types): add duplicate-name detection in buildTypeEnv for cross-file collision errors"
```

---

## Task 5: `main.ts` — wire to `loadProgram`

**Files:**
- Modify: `src/main.ts` (full rewrite)

- [ ] **Step 1: Rewrite `src/main.ts`**

Replace the entire file content:

```typescript
import { loadProgram } from "./loader";
import { check } from "./checker";
import { codegen } from "./codegen";

function printErrors(
  errors: { pos: { line: number; col: number; file: string }; message: string }[]
): void {
  for (const err of errors) {
    console.error(`${err.pos.file}:${err.pos.line}:${err.pos.col}: ${err.message}`);
  }
}

const [, , cmd, file] = process.argv;

if (!cmd || !file) {
  console.error("Usage: fit <check|codegen> <file>");
  process.exit(1);
}

const { program, loadErrors } = loadProgram(file);

if (loadErrors.length > 0) {
  printErrors(loadErrors);
  process.exit(1);
}

if (cmd === "check") {
  const errors = check(program);
  if (errors.length === 0) process.exit(0);
  printErrors(errors);
  process.exit(1);
} else if (cmd === "codegen") {
  const errors = check(program);
  if (errors.length > 0) {
    printErrors(errors);
    process.exit(1);
  }
  process.stdout.write(codegen(program));
  process.exit(0);
} else {
  console.error(`fit: unknown command '${cmd}'`);
  process.exit(1);
}
```

- [ ] **Step 2: Verify the canonical programs still pass**

```bash
cd /Users/kofi/_/fit && npx ts-node src/main.ts check tests/payment.fit && echo "payment: OK"
cd /Users/kofi/_/fit && npx ts-node src/main.ts check tests/smtp.fit && echo "smtp: OK"
cd /Users/kofi/_/fit && npx ts-node src/main.ts check tests/drain.fit && echo "drain: OK"
```

Expected: all three print their `OK` line and exit 0.

- [ ] **Step 3: Run full test suite**

```bash
cd /Users/kofi/_/fit && npm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): wire loadProgram — multi-file programs now supported end-to-end"
```

---

## Task 6: Codegen guard against leaked `import` decls

**Files:**
- Modify: `src/codegen.ts:91` (start of `codegen` function)

- [ ] **Step 1: Add guard at the top of `codegen`**

In `src/codegen.ts`, add the guard as the *first* statement inside the `codegen` function body, before `const { env } = buildTypeEnv(program);`:

```typescript
export function codegen(program: Program): string {
  if (program.decls.some(d => d.kind === "import")) {
    throw new Error(
      "codegen: unexpected import decl in assembled program — loader must strip imports before codegen"
    );
  }
  const { env } = buildTypeEnv(program);
  // ... rest unchanged
```

- [ ] **Step 2: Run codegen tests to confirm no regression**

```bash
cd /Users/kofi/_/fit && npm test -- --testPathPattern=codegen.test 2>&1 | tail -10
```

Expected: all codegen tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/codegen.ts
git commit -m "fix(codegen): guard against import decl leakage from loader"
```

---

## Task 7: Test programs

**Files to create** (14 files across `tests/should_pass/` and `tests/should_fail/`):

### Naming convention for dep files

Dep files use `_dep` suffix or `_a`/`_b` suffix before `.fit`. `suite.test.ts` (updated in Task 9) excludes these from test enumeration, since they are not root programs.

- [ ] **Step 1: Create `tests/should_pass/import_basic_dep.fit`**

```
fn foo() -> ()
```

- [ ] **Step 2: Create `tests/should_pass/import_basic.fit`**

```
import import_basic_dep

fn run() -> () {
    foo()
}
```

- [ ] **Step 3: Create `tests/should_pass/import_resource_chain_b.fit`**

```
resource Widget {
    handle: Int,
    cleanup: drop_widget
}
fn make_widget() -> Widget
fn drop_widget(w: move Widget) -> ()
```

- [ ] **Step 4: Create `tests/should_pass/import_resource_chain_a.fit`**

```
import import_resource_chain_b

fn use_widget(w: move Widget) -> () {
    drop_widget(w)
}
```

- [ ] **Step 5: Create `tests/should_pass/import_resource_chain.fit`**

```
import import_resource_chain_a

fn run() -> () {
    let w = make_widget()
    use_widget(w)
}
```

- [ ] **Step 6: Create `tests/should_pass/import_variant_namespacing_dep.fit`**

```
enum Status { Done, Pending }
fn get_status() -> Status
```

- [ ] **Step 7: Create `tests/should_pass/import_variant_namespacing.fit`**

Exercises §2.5: `Done` exists in both the imported `Status` and local `TaskResult`; qualification is required at the match site.

```
import import_variant_namespacing_dep

enum TaskResult { Done, Failed }
fn report_done() -> ()
fn report_pending() -> ()

fn check_status() -> () {
    let s = get_status()
    match s {
        Status.Done => { report_done() }
        Status.Pending => { report_pending() }
    }
}
```

- [ ] **Step 8: Create `tests/should_fail/import_duplicate_name_a.fit`**

```
resource Connection { cleanup: close_conn_a }
fn close_conn_a(c: move Connection) -> ()
```

- [ ] **Step 9: Create `tests/should_fail/import_duplicate_name_b.fit`**

```
resource Connection { cleanup: close_conn_b }
fn close_conn_b(c: move Connection) -> ()
```

- [ ] **Step 10: Create `tests/should_fail/import_duplicate_name.fit`**

```
import import_duplicate_name_a
import import_duplicate_name_b

fn run() -> ()
```

- [ ] **Step 11: Create `tests/should_fail/import_cycle_dep.fit`**

```
import import_cycle

fn helper() -> ()
```

- [ ] **Step 12: Create `tests/should_fail/import_cycle.fit`**

```
import import_cycle_dep

fn run() -> ()
```

- [ ] **Step 13: Create `tests/should_fail/import_missing_file.fit`**

```
import totally_nonexistent_xyz_999

fn run() -> ()
```

- [ ] **Step 14: Create `tests/should_fail/import_after_decl.fit`**

```
fn foo() -> ()
import other
```

- [ ] **Step 15: Run the new programs manually to verify behavior**

```bash
cd /Users/kofi/_/fit
npx ts-node src/main.ts check tests/should_pass/import_basic.fit && echo "basic: OK"
npx ts-node src/main.ts check tests/should_pass/import_resource_chain.fit && echo "chain: OK"
npx ts-node src/main.ts check tests/should_pass/import_variant_namespacing.fit && echo "variants: OK"
npx ts-node src/main.ts check tests/should_fail/import_duplicate_name.fit; echo "dup exit: $?"
npx ts-node src/main.ts check tests/should_fail/import_cycle.fit; echo "cycle exit: $?"
npx ts-node src/main.ts check tests/should_fail/import_missing_file.fit; echo "missing exit: $?"
npx ts-node src/main.ts check tests/should_fail/import_after_decl.fit; echo "after_decl exit: $?"
```

Expected: should_pass programs exit 0; should_fail programs exit 1 with error messages.

> **⚠️ Intermediate state warning:** At this point, `suite.test.ts` still uses `parse + check` directly (it is rewritten in Task 8). Running `npm test` now will cause the new import programs to **fail in the Jest suite** (the dep programs aren't loaded, so symbols like `foo` are missing). This is expected. Do NOT run `npm test` to validate these programs before Task 8 — use the `npx ts-node` commands above instead.

- [ ] **Step 16: Commit**

```bash
git add tests/should_pass/import_*.fit tests/should_fail/import_*.fit
git commit -m "test: add module system should_pass and should_fail test programs"
```

---

## Task 8: Update `suite.test.ts` to use `loadProgram`

**Files:**
- Modify: `tests/suite.test.ts`

- [ ] **Step 1: Rewrite `tests/suite.test.ts`**

Replace the entire file:

```typescript
import * as fs from "fs";
import * as path from "path";
import { loadProgram } from "../src/loader";
import { check } from "../src/checker";

const SHOULD_PASS_DIR = path.join(__dirname, "should_pass");
const SHOULD_FAIL_DIR = path.join(__dirname, "should_fail");

// Dep files are imported by root test programs; they are not standalone tests.
// Convention: file names containing "_dep" or ending in "_a.fit" / "_b.fit" are deps.
function isDepFile(filename: string): boolean {
  return /_dep/.test(filename) || /_(a|b)\.fit$/.test(filename);
}

function rootFitFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith(".fit") && !isDepFile(f))
    .sort();
}

describe("should_pass", () => {
  const files = rootFitFiles(SHOULD_PASS_DIR);
  if (files.length === 0) {
    it("placeholder — no .fit files yet", () => {});
    return;
  }
  for (const file of files) {
    it(`${file} produces no errors`, () => {
      const absPath = path.join(SHOULD_PASS_DIR, file);
      const { program, loadErrors } = loadProgram(absPath);
      expect(loadErrors).toEqual([]);
      const checkErrors = check(program);
      expect(checkErrors).toEqual([]);
    });
  }
});

describe("should_fail", () => {
  const files = rootFitFiles(SHOULD_FAIL_DIR);
  if (files.length === 0) {
    it("placeholder — no .fit files yet", () => {});
    return;
  }
  for (const file of files) {
    it(`${file} produces at least one error`, () => {
      const absPath = path.join(SHOULD_FAIL_DIR, file);
      const { program, loadErrors } = loadProgram(absPath);
      const checkErrors = loadErrors.length > 0 ? [] : check(program);
      const allErrors = [...loadErrors, ...checkErrors];
      expect(allErrors.length).toBeGreaterThan(0);
    });
  }
});
```

- [ ] **Step 2: Run suite tests**

```bash
cd /Users/kofi/_/fit && npm test -- --testPathPattern=suite.test 2>&1 | tail -20
```

Expected: all should_pass and should_fail tests pass (including the new import tests from Task 7).

- [ ] **Step 3: Run full test suite**

```bash
cd /Users/kofi/_/fit && npm test 2>&1 | tail -15
```

Expected: all tests pass. Note the test count in the output.

- [ ] **Step 4: Commit**

```bash
git add tests/suite.test.ts
git commit -m "feat(suite): update test runner to use loadProgram for multi-file support"
```

---

## Task 9: Docs update

**Files:**
- Modify: `docs/FIT-SYNTAX.md` (add §11)
- Modify: `docs/poc-findings.md` (add v0.1 phase entry)

- [ ] **Step 1: Confirm `docs/FIT-SYNTAX.md` replacement**

`docs/FIT-SYNTAX.md` was replaced with the content of `FIT-SYNTAX-v0.1.md` prior to
Task 0. The new file covers modules in **§9** (not §11) and carries the commit
`"docs: replace FIT-SYNTAX with v0.1 reference"`.

Verify the replacement:

```bash
head -3 docs/FIT-SYNTAX.md
```

Expected: `**Version:** v0.1`

- [ ] **Step 2: Add v0.1 phase entry to `docs/poc-findings.md`**

Locate the "Natural next steps" section and add a new section before it:

```markdown
## v0.1 Phase — Module system (2026-06-08)

### What landed

Minimal flat-namespace module system: `import filename` loads all declarations from
`filename.fit` in the same directory. Implemented in 6 pieces:

- `Decl.import` AST variant + `Pos.file` field
- `parseImport` + imports-first enforcement in parser
- `src/loader.ts` — recursive resolution, memoization, diamond dedup, cycle detection
- Duplicate-name detection in `buildTypeEnv` (also catches within-file duplicates)
- `main.ts` wired to `loadProgram`
- Codegen guard against leaked import decls

### Line count (post-modules)

Run `wc -l src/ast.ts src/parser.ts src/checker.ts src/types.ts src/loader.ts` and
record here after implementation. The watch item is the trend toward or away from the
4×-Austral kill threshold (~2400 lines).

### Test count

Run `npm test` and record total test count here. Previous count: 299.

### Known v0.1 limitations (accepted, deferred to v0.2)

- No visibility — all declarations accessible across files
- No separate compilation — every `import` re-parses at each `fit check` invocation
- No qualified imports, selective imports, or module hierarchy
- Pos.file stores absolute paths — error messages may be verbose in deep directory trees
```

- [ ] **Step 3: Measure and record line count**

```bash
cd /Users/kofi/_/fit && wc -l src/ast.ts src/parser.ts src/checker.ts src/types.ts src/loader.ts
```

Fill in the "Line count" section in `poc-findings.md` with the actual numbers.

- [ ] **Step 4: Record final test count**

```bash
cd /Users/kofi/_/fit && npm test 2>&1 | grep -E "Tests:|passed|failed" | tail -5
```

Fill in the "Test count" section.

- [ ] **Step 5: Commit**

```bash
git add docs/poc-findings.md
git commit -m "docs(findings): add v0.1 phase log entry"
```

---

## Final verification

- [ ] **Run complete test suite one last time**

```bash
cd /Users/kofi/_/fit && npm test 2>&1
```

Expected: all tests pass with no failures.

- [ ] **Confirm canonical programs still pass**

```bash
cd /Users/kofi/_/fit
npx ts-node src/main.ts check tests/payment.fit && echo "payment: OK"
npx ts-node src/main.ts check tests/smtp.fit && echo "smtp: OK"
npx ts-node src/main.ts check tests/drain.fit && echo "drain: OK"
```

Expected: all three exit 0.

---

## Self-review against spec

**Spec coverage check:**

| Brief requirement | Task |
|-------------------|------|
| `Decl.import` AST variant | Task 1 |
| `parseImport` + imports-first error | Task 2 |
| `loadProgram` with recursive resolution | Task 3 |
| Memoization (parse once per compilation) | Task 3 (included set — same mechanism as diamond dedup) |
| Diamond dedup (same file included once) | Task 3 (included set) |
| Cycle detection with clear cycle path | Task 3 |
| Relative-to-importing-file resolution | Task 3 (path.dirname) |
| Duplicate-name detection across files | Task 4 |
| Duplicate-name detection within a file | Task 4 (side benefit) |
| `main.ts` wired to loadProgram | Task 5 |
| LoadErrors printed before checking | Task 5 |
| Codegen guard | Task 6 |
| `should_pass` test programs (3) | Task 7 |
| `should_fail` test programs (4) | Task 7 |
| Loader unit tests (isolated) | Task 3 |
| Findings update | Task 9 |
| Module spec in FIT-SYNTAX.md | Task 9 (§9 in new file, already committed) |
| `Pos.file` design decision | Task 0 |

**Out-of-scope items verified NOT implemented:** no visibility, no qualified imports, no selective imports, no subdirectory resolution, no separate compilation.

**Variant namespacing interaction (Escalation Trigger 2):** The `import_variant_namespacing` test program (Task 7, Step 7) exercises cross-file variant resolution. The existing `resolveVariant` in `types.ts` uses the `TypeEnv.enums` map, which is populated from the assembled program — so all imported variants are present. No code change required. If this test fails unexpectedly, escalate before patching.
