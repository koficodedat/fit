import { execSync } from "child_process";
import * as path from "path";

describe("CLI error path formatting", () => {
  it("error paths are relative to CWD, not absolute", () => {
    // use_after_move.fit is a known should_fail program — always produces errors
    const target = path.join("tests", "should_fail", "use_after_move.fit");
    let stderr = "";
    try {
      execSync(`npx ts-node src/main.ts check ${target}`, {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e: unknown) {
      if (e && typeof e === "object" && "stderr" in e) {
        stderr = (e as { stderr: string }).stderr;
      }
    }
    expect(stderr.length).toBeGreaterThan(0);
    // Every error line must start with a relative path, never an absolute one
    const errorLines = stderr.trim().split("\n").filter(l => l.includes(":"));
    expect(errorLines.length).toBeGreaterThan(0);
    for (const line of errorLines) {
      expect(line.startsWith("/")).toBe(false);
      expect(line.startsWith(target)).toBe(true);
    }
  });
});
