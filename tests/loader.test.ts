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
