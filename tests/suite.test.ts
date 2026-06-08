import * as fs from "fs";
import * as path from "path";
import { loadProgram } from "../src/loader";
import { check } from "../src/checker";

const SHOULD_PASS_DIR = path.join(__dirname, "should_pass");
const SHOULD_FAIL_DIR = path.join(__dirname, "should_fail");

// Dep files are imported by root test programs; they are not standalone tests.
// Convention: file names containing "_dep" or ending in "_a.fit" / "_b.fit" are deps.
function isDepFile(filename: string): boolean {
  return filename.includes("_dep");
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
