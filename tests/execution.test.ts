// Execution tests: for each case under tests/should_run/, load + check + codegen
// the .fit program, compile and link the generated C against its harness, run the
// resulting binary under a timeout, and compare stdout to the expected output.
//
// Unlike codegen.test.ts (text comparison against a snapshot), these tests actually
// execute the generated C — the only place in the suite that does. That is what
// catches a defect like break-in-match-in-loop: text that compiles clean but is
// wrong at runtime.
//
// A case is three files sharing a stem: X.fit, X.harness.c, X.expected_output.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import { loadProgram } from "../src/loader";
import { check } from "../src/checker";
import { codegen } from "../src/codegen";

const SHOULD_RUN_DIR = path.join(__dirname, "should_run");
const TIMEOUT_MS = 5000;

function ccAvailable(): boolean {
  const result = spawnSync("cc", ["--version"]);
  return result.error === undefined && result.status === 0;
}

function discoverStems(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const stems = new Set<string>();
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".fit")) stems.add(f.slice(0, -".fit".length));
  }
  return [...stems].sort();
}

const stems = discoverStems(SHOULD_RUN_DIR);
const hasCc = stems.length > 0 && ccAvailable();

if (stems.length > 0 && !hasCc) {
  console.warn(
    "\n*** tests/execution.test.ts: 'cc' not found on PATH — skipping execution tests. ***\n"
  );
}

describe("should_run (compile, link, and execute generated C)", () => {
  if (stems.length === 0) {
    it("placeholder — no should_run cases found", () => {});
    return;
  }
  if (!hasCc) {
    it.skip("cc unavailable — execution tests skipped", () => {});
    return;
  }

  for (const stem of stems) {
    it(`${stem}: compiles, links, runs, and matches expected stdout`, () => {
      const fitPath = path.join(SHOULD_RUN_DIR, `${stem}.fit`);
      const harnessPath = path.join(SHOULD_RUN_DIR, `${stem}.harness.c`);
      const expectedPath = path.join(SHOULD_RUN_DIR, `${stem}.expected_output`);

      if (!fs.existsSync(harnessPath) || !fs.existsSync(expectedPath)) {
        throw new Error(
          `should_run case '${stem}' is missing a sibling file — a case needs ` +
            `${stem}.fit, ${stem}.harness.c, and ${stem}.expected_output, all present`
        );
      }

      const { program, loadErrors } = loadProgram(fitPath);
      if (loadErrors.length > 0) {
        throw new Error(
          `${stem}: load errors:\n${loadErrors.map((e) => `  ${e.message}`).join("\n")}`
        );
      }
      const checkErrors = check(program);
      if (checkErrors.length > 0) {
        throw new Error(
          `${stem}: type-check errors:\n${checkErrors.map((e) => `  ${e.message}`).join("\n")}`
        );
      }

      const generatedC = codegen(program);
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fit-exec-"));
      const cPath = path.join(workDir, `${stem}.c`);
      const exePath = path.join(workDir, stem);

      try {
        fs.writeFileSync(cPath, generatedC, "utf-8");
        execFileSync("cc", ["-std=c99", "-Werror", cPath, harnessPath, "-o", exePath]);

        let stdout: string;
        try {
          stdout = execFileSync(exePath, [], { timeout: TIMEOUT_MS, encoding: "utf-8" });
        } catch (err: unknown) {
          const e = err as { signal?: string | null; code?: string };
          if (e.signal || e.code === "ETIMEDOUT") {
            throw new Error(
              `${stem}: did not terminate within ${TIMEOUT_MS}ms — non-termination ` +
                `(possible infinite loop in generated C)`
            );
          }
          throw err;
        }

        const expected = fs.readFileSync(expectedPath, "utf-8");
        expect(stdout.replace(/\s+$/, "")).toBe(expected.replace(/\s+$/, ""));
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    });
  }
});
