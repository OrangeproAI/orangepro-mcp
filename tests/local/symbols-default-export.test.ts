import { describe, it, expect } from "vitest";
import { extractSymbols } from "../../src/local/analyze/symbols.js";

const names = (src: string): string[] => extractSymbols(src, "typescript").map((s) => s.name).sort();

describe("collectTsJsExports — default-export subjects (Finding 1)", () => {
  it("records `const X = () => …; export default X` (the React component shape)", () => {
    const src = "const ActionsMenuButton = () => null;\nexport default ActionsMenuButton;\n";
    expect(names(src)).toContain("ActionsMenuButton");
  });

  it("records the wrapped subject of an HOC default, not the wrapper args", () => {
    const src = [
      "const mapStateToProps = (state) => ({ a: state.a });",
      "const mapDispatchToProps = (dispatch) => ({});",
      "const ActionsMenuButton = () => null;",
      "export default connect(mapStateToProps, mapDispatchToProps)(ActionsMenuButton);"
    ].join("\n");
    const got = names(src);
    expect(got).toContain("ActionsMenuButton"); // the subject IS recorded
    expect(got).not.toContain("mapStateToProps"); // inner-call args are NOT the subject
    expect(got).not.toContain("mapDispatchToProps");
  });

  it("handles nested HOCs (injectIntl(connect(...)(X)) and memo(X))", () => {
    expect(names("const C = () => null;\nexport default injectIntl(connect(m)(C));\n")).toContain("C");
    expect(names("const C = () => null;\nexport default React.memo(C);\n")).toContain("C");
  });

  it("still records `export default function/class Foo` (named declaration form)", () => {
    expect(names("export default function Widget() { return 1; }\n")).toContain("Widget");
    expect(names("export default class Panel { render() {} }\n")).toContain("Panel");
  });

  it("a const declared AFTER the default export still resolves", () => {
    const src = "export default Late;\nconst Late = () => null;\n";
    expect(names(src)).toContain("Late");
  });

  it("records call-wrapped component consts (forwardRef / memo / styled / HOC-of-Impl)", () => {
    // The real Mattermost shapes: const is initialized by a CALL, not an arrow.
    expect(names("const ActionsMenuButton = React.forwardRef(() => null);\nexport default ActionsMenuButton;\n")).toContain("ActionsMenuButton");
    expect(names("import Impl from './i';\nconst C = memo(Impl);\nexport default C;\n")).toContain("C");
    expect(names("const Styled = styled.div`color:red`;\nexport default Styled;\n")).toContain("Styled");
    // const MenuItemBlockableLink = menuItem(Impl); export default it
    expect(names("const MenuItemBlockableLink = menuItem(MenuItemBlockableLinkImpl);\nexport default MenuItemBlockableLink;\n")).toContain("MenuItemBlockableLink");
  });

  describe("conservative — never invents behavior", () => {
    it("anonymous default is not recorded", () => {
      expect(names("export default function () { return 1; }\n")).toEqual([]);
      expect(names("export default () => null;\n")).toEqual([]);
    });
    it("a non-callable value default (plain object/config) is not recorded", () => {
      expect(names("const config = { a: 1 };\nexport default config;\n")).toEqual([]);
      expect(names("export default { a: 1 };\n")).toEqual([]);
    });
    it("does NOT count require() re-export shims, new-expr singletons, or lowercase call results (Codex #59)", () => {
      // CommonJS re-export shim — configureStore is counted in its own file.
      expect(names("const config = require('./configureStore').default;\nexport default config;\n")).toEqual([]);
      expect(names("const x = require('./x');\nexport default x;\n")).toEqual([]);
      // new-expression singleton — the CLASS is the behavior, counted elsewhere.
      expect(names("const WebClient = new WebSocketClient();\nexport default WebClient;\n")).toEqual([]);
      // lowercase call result (route/config object built by a call) — not a component.
      expect(names("const routes = createRoutesFromElements(x);\nexport default routes;\n")).toEqual([]);
    });
    it("keeps a lowercase arrow/function default (a real function, any case)", () => {
      expect(names("const useThing = () => 1;\nexport default useThing;\n")).toContain("useThing");
    });
    it("an IMPORTED subject is not counted as this file's behavior (no double-count)", () => {
      const src = "import Bar from './bar';\nexport default connect(m)(Bar);\n";
      expect(names(src)).not.toContain("Bar");
    });
    it("a default RE-EXPORT barrel adds no new behavior", () => {
      expect(names("export { default } from './x';\n")).toEqual([]);
      expect(names("export { default as Thing } from './x';\n")).not.toContain("Thing");
    });
    it("an import-then-default barrel (index.ts re-export) adds no new behavior", () => {
      // `import X from './x'; export default X` — X is defined & counted in ./x.
      expect(names("import FullLogEventModal from './full_log_event_modal';\nexport default FullLogEventModal;\n")).toEqual([]);
    });
  });

  it("does not double-count a subject that is also a named export", () => {
    const src = "export const Foo = () => null;\nexport default Foo;\n";
    expect(names(src).filter((n) => n === "Foo")).toHaveLength(1);
  });
});
