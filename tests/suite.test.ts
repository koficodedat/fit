import * as fs from "fs";
import * as path from "path";
import { parse } from "../src/parser";
import { check } from "../src/checker";

const SHOULD_PASS_DIR = path.join(__dirname, "should_pass");
const SHOULD_FAIL_DIR = path.join(__dirname, "should_fail");

function fitFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(".fit")).sort();
}

describe("should_pass", () => {
  const files = fitFiles(SHOULD_PASS_DIR);
  if (files.length === 0) {
    it("placeholder — no .fit files yet", () => {});
    return;
  }
  for (const file of files) {
    it(`${file} produces no errors`, () => {
      const src = fs.readFileSync(path.join(SHOULD_PASS_DIR, file), "utf8");
      const errors = check(parse(src, file));
      expect(errors).toEqual([]);
    });
  }
});

describe("should_fail", () => {
  const files = fitFiles(SHOULD_FAIL_DIR);
  if (files.length === 0) {
    it("placeholder — no .fit files yet", () => {});
    return;
  }
  for (const file of files) {
    it(`${file} produces at least one error`, () => {
      const src = fs.readFileSync(path.join(SHOULD_FAIL_DIR, file), "utf8");
      const errors = check(parse(src, file));
      expect(errors.length).toBeGreaterThan(0);
    });
  }
});
