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
