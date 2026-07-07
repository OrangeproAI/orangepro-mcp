import { describe, it, expect } from "vitest";
import { extractCalls } from "../../src/local/analyze/callGraph.js";

const calls = (src: string, tsx = false) => extractCalls(src, tsx);
const pairs = (src: string, tsx = false) => calls(src, tsx).map((c) => `${c.caller}->${c.callee}(${c.via})`).sort();

describe("extractCalls — raw (caller, callee) pairs", () => {
  it("attributes a free call to the enclosing function", () => {
    expect(pairs("function a() { b(); }")).toEqual(["a->b(free)"]);
  });

  it("attributes a call inside a class method to Class.method", () => {
    expect(pairs("class C { m() { helper(); } }")).toEqual(["C.m->helper(free)"]);
  });

  it("attributes a call inside a const arrow to the const name", () => {
    expect(pairs("const X = () => { doThing(); };")).toEqual(["X->doThing(free)"]);
  });

  it("inherits the enclosing named scope through anonymous closures", () => {
    expect(pairs("const X = () => { items.map(() => render()); };")).toContain("X->render(free)");
  });

  it("captures this.member and static Class.member forms", () => {
    const got = pairs("class C { m() { this.helper(); C.make(); } }");
    expect(got).toContain("C.m->helper(this)");
    expect(got).toContain("C.m->make(static)");
  });

  it("records the static qualifier", () => {
    const c = calls("class C { m() { Other.build(); } }").find((x) => x.via === "static");
    expect(c?.qualifier).toBe("Other");
    expect(c?.callee).toBe("build");
  });

  it("drops calls with no enclosing named symbol (module scope)", () => {
    expect(pairs("doSideEffect();\n(function(){ alsoCalled(); })();")).toEqual([]);
  });

  it("drops chained / element-access call forms at extraction (only id/this/id.member kept)", () => {
    // `a.b.c()` (member-on-member) and `arr[0]()` (element access) are not a bare
    // identifier, `this.x`, or `Identifier.member` → never captured. `obj.method()`
    // and `fn?.()` ARE captured raw (static/free) but the ANALYZER drops them when
    // the qualifier isn't a same-file class / the name isn't a known symbol —
    // see the integration test. This keeps "exactness" a resolution guarantee.
    const got = pairs("function a() { a.b.c(); arr[0](); }");
    expect(got).toEqual([]);
  });

  it("captures forwardRef/HOC component-body calls under the const name", () => {
    expect(pairs("const W = React.forwardRef(() => { useThing(); return null; });", true)).toEqual(["W->useThing(free)"]);
  });

  it("drops calls inside a NESTED named function declaration (cannot impersonate an emitted symbol)", () => {
    // A nested `function inner` is a local — its name must not become a caller
    // that the analyzer matches against a same-named emitted top-level symbol.
    expect(pairs("function outer() { function inner() { deep(); } }")).toEqual([]);
  });

  describe("scope-aware shadowing (Codex #62 HIGH — no guessing)", () => {
    it("drops a free call shadowed by a parameter", () => {
      expect(pairs("function run(helper) { return helper(); }")).toEqual([]);
    });
    it("drops a free call shadowed by a local const/let/var", () => {
      expect(pairs("function run() { const helper = () => 1; return helper(); }")).toEqual([]);
      expect(pairs("function run() { helper(); var helper; }")).toEqual([]); // var hoisting
    });
    it("drops a free call shadowed by a destructured / catch / nested-fn binding", () => {
      expect(pairs("function run({ helper }) { return helper(); }")).toEqual([]);
      expect(pairs("function run() { try {} catch (helper) { helper(); } }")).toEqual([]);
      // a LOCAL `function helper` shadows — the call targets the local, not an export.
      expect(pairs("function run() { function helper() {} return helper(); }")).toEqual([]);
    });
    it("drops a static call whose qualifier is shadowed by a local", () => {
      expect(pairs("function run(C) { return C.build(); }")).toEqual([]);
    });
    it("an arrow parameter shadows the callee", () => {
      expect(pairs("const X = (render) => render();")).toEqual([]);
    });

    it("drops this.member() inside a non-arrow function expression (this is rebound) (Codex #62)", () => {
      const got = pairs("class C { helper() {} run() { setTimeout(function () { this.helper(); }); } }");
      expect(got).not.toContain("C.run->helper(this)"); // function() {} rebinds this
    });
    it("KEEPS this.member() inside an arrow callback (lexical this preserved)", () => {
      const got = pairs("class C { helper() {} run() { setTimeout(() => { this.helper(); }); } }");
      expect(got).toContain("C.run->helper(this)");
    });
    it("drops a bare this.member() at module scope or in a free function (no class this)", () => {
      expect(pairs("function run() { this.helper(); }")).toEqual([]);
    });
    it("a closure param shadows only within the closure, not the outer scope", () => {
      // outer `save()` is NOT shadowed; inner `(save) => save()` IS. (`list.forEach`
      // is captured raw as static but resolution drops it — `list` is no class.)
      const got = pairs("function run() { save(); list.forEach((save) => save()); }");
      expect(got.filter((p) => p.includes("save"))).toEqual(["run->save(free)"]); // exactly one save edge
    });
  });

  describe("nested-declaration impersonation (Codex #62 round-3)", () => {
    it("a nested function named like an emitted symbol does not become a caller", () => {
      const got = pairs("export function inner() {}\nexport function outer() { function inner() { target(); } inner(); }");
      expect(got.some((p) => p.startsWith("inner->"))).toBe(false);
    });
    it("a nested class named like an emitted class yields no member callers", () => {
      const got = pairs("export class C { run() {} }\nexport function outer() { class C { run() { this.helper(); } } }");
      expect(got.some((p) => p.startsWith("C.run->"))).toBe(false);
    });
    it("a nested const arrow named like an emitted symbol does not become a caller", () => {
      const got = pairs("export const handler = () => {};\nexport function outer() { const handler = () => target(); handler(); }");
      expect(got.some((p) => p.startsWith("handler->"))).toBe(false);
    });
    it("a namespace-nested function does not impersonate a top-level emitted symbol (Codex #62 round-4)", () => {
      const got = pairs("export function target() {}\nexport function inner() {}\nnamespace N { export function inner() { target(); } }");
      expect(got.some((p) => p.startsWith("inner->"))).toBe(false);
    });
    it("a namespace-nested class yields no member callers", () => {
      const got = pairs("export class C { helper() {} run() {} }\nnamespace N { export class C { helper() {} run() { this.helper(); } } }");
      expect(got.some((p) => p.startsWith("C.run->"))).toBe(false);
    });
    it("the same applies to `module M { … }` declarations", () => {
      const got = pairs("export function inner() {}\nmodule M { export function inner() { target(); } }");
      expect(got.some((p) => p.startsWith("inner->"))).toBe(false);
    });
  });
});
