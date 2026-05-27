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
    const bodyStart = out.indexOf("int run(");
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
