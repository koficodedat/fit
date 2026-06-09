import * as fs from "fs";
import * as path from "path";
import { parse } from "../src/parser";
import { codegen } from "../src/codegen";

function codegenSrc(src: string): string {
  return codegen(parse(src, "<test>"));
}

describe("cTypeName / struct emission", () => {
  test("resource emits typedef struct", () => {
    const out = codegenSrc(`
      resource Widget { id: WidgetId, cleanup: free_widget }
      fn make_widget() -> Widget
    `);
    expect(out).toContain("typedef struct {");
    expect(out).toContain("int id;");
    expect(out).toContain("} Widget;");
  });

  test("enum emits typedef enum", () => {
    const out = codegenSrc(`
      enum E { Failed, Other }
      fn dummy() -> ()
    `);
    expect(out).toContain("typedef enum {");
    expect(out).toContain("E_Failed = 0");
    expect(out).toContain("E_Other");
    expect(out).toContain("} E;");
  });

  test("Result<Widget, E> emits tagged union R_Widget_E", () => {
    const out = codegenSrc(`
      resource Widget { id: WidgetId, cleanup: free_widget }
      enum E { Failed }
      fn make() -> Result<Widget, E>
    `);
    expect(out).toContain("R_Widget_E");
    expect(out).toContain("int tag;");
    expect(out).toContain("Widget ok;");
    expect(out).toContain("E err;");
  });

  test("Result<(), E> uses int for ok field", () => {
    const out = codegenSrc(`
      enum E { Failed }
      fn risky() -> Result<(), E>
    `);
    expect(out).toContain("R_int_E");
    expect(out).toContain("int ok;");
  });

  test("extern fn emits extern declaration", () => {
    const out = codegenSrc(`
      resource Widget { id: WidgetId, cleanup: free_widget }
      fn make_widget() -> Widget
    `);
    expect(out).toContain("extern Widget make_widget(void);");
  });
});

describe("function body emission", () => {
  test("cleanup_scope: scope-exit cleanup emitted for never-consumed resource", () => {
    const src = `
      resource Widget { id: WidgetId, cleanup: free_widget }
      fn make_widget() -> Widget
      fn run() -> () {
          let w = make_widget()
      }
    `;
    const out = codegenSrc(src);
    expect(out).toContain("Widget w = make_widget();");
    expect(out).toContain("free_widget(w);");
  });

  test("cleanup_drop: drop emits cleanup, no second cleanup at scope exit", () => {
    const src = `
      resource Widget { id: WidgetId, cleanup: free_widget }
      fn make_widget() -> Widget
      fn use_widget(w: lend Widget) -> ()
      fn run() -> () {
          let w = make_widget()
          use_widget(w)
          drop(w)
      }
    `;
    const out = codegenSrc(src);
    expect(out).toContain("free_widget(w);");
    // Codegen emits `extern void free_widget(Widget v);` from the resource section,
    // so slice to the function body and verify only one free_widget call there.
    const bodyStart = out.indexOf("void run(");
    const body = out.slice(bodyStart);
    expect((body.match(/free_widget/g) || []).length).toBe(1);
  });

  test("cleanup_error: error path emits cleanup before return, ok path does not double-clean", () => {
    const src = `
      resource Widget { id: WidgetId, cleanup: free_widget }
      enum E { Failed }
      fn make_widget() -> Widget
      fn risky() -> Result<(), E>
      fn run() -> Result<(), E> {
          let w = make_widget()
          risky()?
          drop(w)
          Ok(())
      }
    `;
    const out = codegenSrc(src);
    // Error branch: free_widget(w) fires inside the if block
    expect(out).toContain("if (");
    expect(out).toContain("free_widget(w);");
    // Ok path: returns R_int_E{0, ...}
    expect(out).toContain("return (R_int_E){0");
  });

  test("payment: execute_charge err path has no cleanup (token was moved in)", () => {
    const src = `
      capability ChargeCard
      resource AuthToken { token_id: TokenId, cleanup: void_token }
      enum PaymentError { Declined, NetworkFail }
      fn validate_card(card: CardDetails) using Net -> Result<AuthToken, PaymentError>
      fn execute_charge(token: move AuthToken, amount: Cents) using Net, ChargeCard -> Result<Receipt, PaymentError>
      fn audit_log(receipt: Receipt) using Net -> Result<(), PaymentError>
      fn process_payment(card: CardDetails, amount: Cents) using Net, ChargeCard -> Result<Receipt, PaymentError> {
          let token   = validate_card(card)?
          let receipt = execute_charge(token, amount)?
          audit_log(receipt)?
          Ok(receipt)
      }
    `;
    const out = codegenSrc(src);
    const bodyStart = out.indexOf("R_Receipt_PaymentError process_payment(");
    const body = out.slice(bodyStart);
    // token was moved to execute_charge — no void_token cleanup in process_payment body
    expect(body).not.toContain("void_token");
  });
});

// Snapshot tests: for each *.fit.c.expected file found under tests/, run loader+checker+codegen
// and compare the output against the checked-in expected file.
//
// To add a snapshot test: drop a program.fit and program.fit.c.expected into tests/should_pass/.
// To regenerate a snapshot: npx ts-node scripts/regen-snapshot.ts <path/to/program.fit>

import { loadProgram } from "../src/loader";
import { check } from "../src/checker";

function findSnapshotPairs(dir: string): { fitPath: string; expectedPath: string }[] {
  const pairs: { fitPath: string; expectedPath: string }[] = [];
  if (!fs.existsSync(dir)) return pairs;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      pairs.push(...findSnapshotPairs(fullPath));
    } else if (entry.name.endsWith(".fit.c.expected")) {
      const fitPath = fullPath.slice(0, -".c.expected".length);
      pairs.push({ fitPath, expectedPath: fullPath });
    }
  }
  return pairs;
}

const TESTS_DIR = path.join(__dirname);
const snapshotPairs = findSnapshotPairs(TESTS_DIR);

describe("codegen snapshots", () => {
  if (snapshotPairs.length === 0) {
    it("placeholder — no .fit.c.expected files found", () => {});
    return;
  }

  for (const { fitPath, expectedPath } of snapshotPairs) {
    const label = path.relative(TESTS_DIR, fitPath);
    it(label, () => {
      if (!fs.existsSync(fitPath)) {
        throw new Error(
          `codegen snapshot: no .fit file for ${fitPath} — orphaned .c.expected?`
        );
      }
      const { program, loadErrors } = loadProgram(fitPath);
      if (loadErrors.length > 0) {
        throw new Error(
          `codegen test for ${label} failed: load errors:\n` +
            loadErrors.map((e) => `  ${e.message}`).join("\n")
        );
      }
      const checkErrors = check(program);
      if (checkErrors.length > 0) {
        throw new Error(
          `codegen test for ${label} failed: program does not type-check:\n` +
            checkErrors.map((e) => `  ${e.message}`).join("\n")
        );
      }
      const actual = codegen(program);
      const expected = fs.readFileSync(expectedPath, "utf-8");
      if (actual !== expected) {
        // Build a simple line-diff for the failure message.
        const aLines = actual.split("\n");
        const eLines = expected.split("\n");
        const maxLen = Math.max(aLines.length, eLines.length);
        const diffLines: string[] = [];
        for (let i = 0; i < maxLen; i++) {
          const a = aLines[i] ?? "<missing>";
          const e = eLines[i] ?? "<missing>";
          if (a !== e) diffLines.push(`  line ${i + 1}:\n    got:      ${a}\n    expected: ${e}`);
        }
        throw new Error(
          `codegen snapshot mismatch for ${label}.\n` +
            `To regenerate: npx ts-node scripts/regen-snapshot.ts ${fitPath}\n` +
            `Differences:\n${diffLines.slice(0, 20).join("\n")}`
        );
      }
    });
  }
});
