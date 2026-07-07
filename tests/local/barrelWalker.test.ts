import { describe, it, expect, beforeEach } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { walkBarrel } from "../../src/local/resolve/barrelWalker.js";
import { resetResolverCaches } from "../../src/local/resolve/resolver.js";
import { resetExportIndexCache, type ExportIndex } from "../../src/local/resolve/exportIndex.js";

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), "__fixtures__/barrel");
const INDEX = resolve(FIX, "index.ts");
const DEFS = resolve(FIX, "defs.ts");
const MORE = resolve(FIX, "more.ts");
const AMBIG_INDEX = resolve(FIX, "ambig/index.ts");
const STAR1 = resolve(FIX, "ambig/star1.ts");
const STAR2 = resolve(FIX, "ambig/star2.ts");
const CYCLIC_A = resolve(FIX, "cyclic-a.ts");
const CYCLIC_B = resolve(FIX, "cyclic-b.ts");
const L0 = resolve(FIX, "deep/l0.ts");
const L1 = resolve(FIX, "deep/l1.ts");
const L6 = resolve(FIX, "deep/l6.ts");
const REEXPORT_IMPORTED = resolve(FIX, "reexport-imported.ts");
const LOCAL_REEXPORT = resolve(FIX, "local-reexport.ts");

beforeEach(() => {
  resetResolverCaches();
  resetExportIndexCache();
});

describe("walkBarrel — terminal resolution (COVERS-eligible)", () => {
  it("follows a single `export *` to the defining file (same binding name)", () => {
    const r = walkBarrel(INDEX, "saveUser");
    expect(r.status).toBe("terminal");
    expect(r.terminalFile).toBe(DEFS);
    expect(r.terminalBinding).toBe("saveUser");
    expect(r.covered).toBe(true);
  });

  it("follows a named `export { x } from` to its terminal", () => {
    const r = walkBarrel(INDEX, "fetchData");
    expect(r.status).toBe("terminal");
    expect(r.terminalFile).toBe(MORE);
    expect(r.terminalBinding).toBe("fetchData");
  });

  it("follows a renamed `export { x as y } from`, reporting the SOURCE binding name", () => {
    const r = walkBarrel(INDEX, "storeUser");
    expect(r.status).toBe("terminal");
    expect(r.terminalFile).toBe(DEFS);
    expect(r.terminalBinding).toBe("saveUser"); // the name at the terminal, not the alias
    expect(r.covered).toBe(true);
  });

  it("resolves a binding defined locally in the start file at depth 0", () => {
    const r = walkBarrel(LOCAL_REEXPORT, "localFn");
    expect(r.status).toBe("terminal");
    expect(r.terminalFile).toBe(LOCAL_REEXPORT);
    expect(r.depth).toBe(0);
  });

  it("follows a synthesized re-export of an imported binding to the real terminal", () => {
    const r = walkBarrel(REEXPORT_IMPORTED, "saveUser");
    expect(r.status).toBe("terminal");
    expect(r.terminalFile).toBe(DEFS);
  });
});

describe("walkBarrel — ambiguity and dead-ends (DOWNGRADE to inferred)", () => {
  it("two stars supplying the same name is ambiguous", () => {
    const r = walkBarrel(AMBIG_INDEX, "dup");
    expect(r.status).toBe("ambiguous");
    expect(r.covered).toBe(false);
  });

  it("when exactly ONE of several stars supplies the name, it is deterministic", () => {
    const a = walkBarrel(AMBIG_INDEX, "only1");
    expect(a.status).toBe("terminal");
    expect(a.terminalFile).toBe(STAR1);
    const b = walkBarrel(AMBIG_INDEX, "only2");
    expect(b.status).toBe("terminal");
    expect(b.terminalFile).toBe(STAR2);
  });

  it("a name supplied by no re-export is unresolved", () => {
    expect(walkBarrel(INDEX, "nope").status).toBe("unresolved");
    expect(walkBarrel(AMBIG_INDEX, "ghost").status).toBe("unresolved");
  });
});

describe("walkBarrel — termination guarantees", () => {
  it("resolves a binding reachable through a cyclic barrel pair without hanging", () => {
    const r = walkBarrel(CYCLIC_A, "onlyB");
    expect(r.status).toBe("terminal");
    expect(r.terminalFile).toBe(CYCLIC_B);
    expect(walkBarrel(CYCLIC_A, "onlyA").terminalFile).toBe(CYCLIC_A);
  });

  it("a never-defined name in a cyclic barrel terminates as `cycle`, not a hang", () => {
    const r = walkBarrel(CYCLIC_A, "ghost");
    expect(r.status).toBe("cycle");
    expect(r.covered).toBe(false);
  });

  it("a chain deeper than maxDepth (5) downgrades to depth-exceeded", () => {
    expect(walkBarrel(L0, "deep6").status).toBe("depth-exceeded"); // 6 hops
    const atBoundary = walkBarrel(L1, "deep6"); // exactly 5 hops
    expect(atBoundary.status).toBe("terminal");
    expect(atBoundary.terminalFile).toBe(L6);
    expect(atBoundary.depth).toBe(5);
  });

  it("a higher maxDepth lets the deep chain reach its terminal", () => {
    const r = walkBarrel(L0, "deep6", { maxDepth: 6 });
    expect(r.status).toBe("terminal");
    expect(r.terminalFile).toBe(L6);
    expect(r.depth).toBe(6);
  });
});

describe("walkBarrel — type-only is terminal-but-NOT-covered", () => {
  const TYPES = resolve(FIX, "types.ts");
  const TYPE_REEXPORT = resolve(FIX, "type-reexport.ts");
  const RUNTIME_STAR_TO_TYPE = resolve(FIX, "runtime-star-to-type.ts");
  const ELEMENT_TYPE = resolve(FIX, "element-type.ts");

  it("a `export type { x } from` hop is not covered, even for a runtime terminal", () => {
    const model = walkBarrel(TYPE_REEXPORT, "Model");
    expect(model.status).toBe("terminal");
    expect(model.terminalFile).toBe(TYPES);
    expect(model.terminalKind).toBe("type");
    expect(model.covered).toBe(false);

    const fn = walkBarrel(TYPE_REEXPORT, "realFn"); // runtime terminal, but reached via a type-only hop
    expect(fn.status).toBe("terminal");
    expect(fn.terminalKind).toBe("function");
    expect(fn.covered).toBe(false);
  });

  it("a runtime `export *` that lands on a TYPE terminal is not covered", () => {
    const model = walkBarrel(RUNTIME_STAR_TO_TYPE, "Model");
    expect(model.status).toBe("terminal");
    expect(model.terminalKind).toBe("type");
    expect(model.covered).toBe(false);

    const fn = walkBarrel(RUNTIME_STAR_TO_TYPE, "realFn");
    expect(fn.status).toBe("terminal");
    expect(fn.covered).toBe(true); // runtime terminal via a runtime hop
  });

  it("element-level `export { type X, y }` covers only the runtime element", () => {
    expect(walkBarrel(ELEMENT_TYPE, "Model").covered).toBe(false);
    expect(walkBarrel(ELEMENT_TYPE, "realFn").covered).toBe(true);
  });
});

describe("walkBarrel — `default` is never forwarded through `export *`", () => {
  const DEF_DEFAULT = resolve(FIX, "def-default.ts");
  const STAR_DEFAULT = resolve(FIX, "star-default.ts");
  const STAR_DEFAULT_MULTI = resolve(FIX, "star-default-multi.ts");
  const NAMED_DEFAULT = resolve(FIX, "named-default.ts");

  it("a single `export *` does NOT forward the source's default (TS: no default export)", () => {
    const r = walkBarrel(STAR_DEFAULT, "default");
    expect(r.status).toBe("unresolved");
    expect(r.covered).toBe(false);
  });

  it("a named (non-default) binding still forwards through that same star", () => {
    const r = walkBarrel(STAR_DEFAULT, "alsoNamed");
    expect(r.status).toBe("terminal");
    expect(r.terminalFile).toBe(DEF_DEFAULT);
    expect(r.covered).toBe(true);
  });

  it("2+ stars never forward a default either", () => {
    expect(walkBarrel(STAR_DEFAULT_MULTI, "default").status).toBe("unresolved");
  });

  it("an explicit `export { default as X } from` DOES forward and stays covered", () => {
    const r = walkBarrel(NAMED_DEFAULT, "RealDefault");
    expect(r.status).toBe("terminal");
    expect(r.terminalFile).toBe(DEF_DEFAULT);
    expect(r.terminalBinding).toBe("default");
    expect(r.covered).toBe(true);
  });

  it("a locally-defined `export default` is still reachable at depth 0 (guard is star-only)", () => {
    const r = walkBarrel(DEF_DEFAULT, "default");
    expect(r.status).toBe("terminal");
    expect(r.terminalFile).toBe(DEF_DEFAULT);
    expect(r.depth).toBe(0);
    expect(r.covered).toBe(true);
  });
});

describe("walkBarrel — a type-only IMPORT re-exported is not covered", () => {
  const TYPE_IMPORT_REEXPORT = resolve(FIX, "type-import-reexport.ts");
  const TYPES = resolve(FIX, "types.ts");

  it("`import type {realFn}; export {realFn}` re-exports a type, not a runtime value", () => {
    const r = walkBarrel(TYPE_IMPORT_REEXPORT, "realFn");
    expect(r.status).toBe("terminal");
    expect(r.terminalFile).toBe(TYPES);
    expect(r.terminalKind).toBe("function"); // terminal def IS runtime...
    expect(r.covered).toBe(false); // ...but it was reached via a type-only re-export
  });
});

describe("walkBarrel — multi-star determinism and the expansion budget", () => {
  // Two stars to the SAME terminal: one runtime, one type-only. covered must be
  // true regardless of star declaration order (prefer-covered collapse).
  const B = "/virt/B.ts";
  const T = "/virt/T.ts";
  const terminalT: ExportIndex = { file: T, local: new Map([["foo", "function"]]), reexports: [], isBarrel: false };
  const resolveSame = (spec: string) => (spec === "rt" || spec === "type" ? T : null);
  const idxWith =
    (order: ("rt" | "type")[]) =>
    (f: string): ExportIndex => {
      if (f === T) return terminalT;
      if (f === B)
        return {
          file: B,
          local: new Map(),
          isBarrel: true,
          reexports: order.map((o) => ({ kind: "star" as const, specifier: o, isTypeOnly: o === "type" }))
        };
      return { file: f, local: new Map(), reexports: [], isBarrel: false };
    };

  it("a runtime + type-only star to the same terminal is covered regardless of order", () => {
    const a = walkBarrel(B, "foo", { resolve: resolveSame, loadIndex: idxWith(["type", "rt"]) });
    const b = walkBarrel(B, "foo", { resolve: resolveSame, loadIndex: idxWith(["rt", "type"]) });
    expect(a.status).toBe("terminal");
    expect(a.covered).toBe(true);
    expect(b.covered).toBe(true);
  });

  it("downgrades to budget-exhausted when the work budget trips before the depth bound", () => {
    // An infinite distinct single-star chain: depth bound is 100 but the budget
    // (7) trips first, proving total work — not just chain length — is bounded.
    const loadIndex = (f: string): ExportIndex => ({
      file: f,
      local: new Map(),
      isBarrel: true,
      reexports: [{ kind: "star" as const, specifier: "next", isTypeOnly: false }]
    });
    const resolveChain = (_spec: string, from: string) => `${from}/next`;
    const r = walkBarrel("/c0", "foo", { loadIndex, resolve: resolveChain, maxDepth: 100, maxExpansions: 7 });
    expect(r.status).toBe("budget-exhausted");
    expect(r.covered).toBe(false);
    expect(r.depth).toBe(7); // stopped by the budget, well under maxDepth 100
  });
});

describe("walkBarrel — exploration cuts POISON the multi-star collapse (never false-confirm)", () => {
  const CUT_AMBIG = resolve(FIX, "cut-ambig.ts");
  const EXT_STAR = resolve(FIX, "ext-star.ts");

  it("a depth-cut sibling branch poisons a genuinely ambiguous barrel (TS2308 case)", () => {
    // cut-ambig star-exports `deep6` from BOTH impl-deep6.ts (depth 1) and the
    // 7-hop deep/ chain. At the default depth bound the deep branch is CUT, so
    // confirming the shallow terminal would be a false-confirm — TS rejects the
    // barrel with TS2308 (conflicting star exports).
    const r = walkBarrel(CUT_AMBIG, "deep6");
    expect(r.status).toBe("depth-exceeded");
    expect(r.covered).toBe(false);
  });

  it("with depth raised so both branches complete, the same barrel is conclusively ambiguous", () => {
    const r = walkBarrel(CUT_AMBIG, "deep6", { maxDepth: 8 });
    expect(r.status).toBe("ambiguous");
    expect(r.covered).toBe(false);
  });

  it("an unexpandable star poisons the collapse even when another star has the binding", () => {
    // `nonexistent-pkg-zz` cannot be expanded — it could supply ANY name, so the
    // defs.ts terminal for saveUser cannot be proven unique.
    const r = walkBarrel(EXT_STAR, "saveUser");
    expect(r.status).toBe("unresolved");
    expect(r.covered).toBe(false);
  });

  it("budget exhaustion mid-probe never confirms, regardless of star order", () => {
    // B has two runtime stars to DISTINCT same-name terminals; one branch is a
    // long chain. With a small budget, whichever order the stars appear in, the
    // walk must NOT confirm the quick terminal while the other branch was cut.
    const TA = "/v/ta.ts";
    const chainAt = (f: string): boolean => f.startsWith("/v/chain");
    const loadIndexFor =
      (order: ("quick" | "deep")[]) =>
      (f: string): ExportIndex => {
        if (f === TA) return { file: TA, local: new Map([["foo", "function"]]), reexports: [], isBarrel: false };
        if (chainAt(f)) {
          const n = Number(f.replace("/v/chain", "").replace(".ts", ""));
          if (n >= 40) return { file: f, local: new Map([["foo", "function"]]), reexports: [], isBarrel: false };
          return {
            file: f,
            local: new Map(),
            isBarrel: true,
            reexports: [{ kind: "star" as const, specifier: `next${n + 1}`, isTypeOnly: false }]
          };
        }
        return {
          file: f,
          local: new Map(),
          isBarrel: true,
          reexports: order.map((o) => ({
            kind: "star" as const,
            specifier: o,
            isTypeOnly: false
          }))
        };
      };
    const resolveFn = (spec: string): string | null => {
      if (spec === "quick") return TA;
      if (spec === "deep") return "/v/chain0.ts";
      if (spec.startsWith("next")) return `/v/chain${spec.slice(4)}.ts`;
      return null;
    };
    const a = walkBarrel("/v/b.ts", "foo", { resolve: resolveFn, loadIndex: loadIndexFor(["quick", "deep"]), maxDepth: 100, maxExpansions: 5 });
    const b = walkBarrel("/v/b.ts", "foo", { resolve: resolveFn, loadIndex: loadIndexFor(["deep", "quick"]), maxDepth: 100, maxExpansions: 5 });
    expect(a.covered).toBe(false);
    expect(b.covered).toBe(false);
    expect(a.status).toBe("budget-exhausted");
    expect(b.status).toBe("budget-exhausted");
  });

  it("a conclusive sibling (binding genuinely absent) is still droppable — no over-poisoning", () => {
    // The existing ambig fixture: only1 exists only in star1; star2 is fully
    // explored and conclusively lacks it. That must STILL confirm.
    const r = walkBarrel(resolve(FIX, "ambig/index.ts"), "only1");
    expect(r.status).toBe("terminal");
    expect(r.covered).toBe(true);
  });
});

describe("walkBarrel — declaration files are never COVERS-eligible", () => {
  const DTS = resolve(FIX, "ambient-defs.d.ts");
  const DTS_BARREL = resolve(FIX, "dts-barrel.ts");

  it("a .d.ts terminal is terminal-but-NOT-covered, directly and through a barrel", () => {
    const direct = walkBarrel(DTS, "ambientFn");
    expect(direct.status).toBe("terminal");
    expect(direct.covered).toBe(false);

    const viaBarrel = walkBarrel(DTS_BARREL, "ambientFn");
    expect(viaBarrel.status).toBe("terminal");
    expect(viaBarrel.terminalFile).toBe(DTS);
    expect(viaBarrel.covered).toBe(false);
  });
});

describe("walkBarrel — ambient `declare` in a regular .ts file is never covered", () => {
  const AMBIENT_TS = resolve(FIX, "ambient-ts.ts");

  it("export declare function/class/const are terminal-but-NOT-covered; real fn is covered", () => {
    for (const binding of ["ambientTsFn", "AmbientTsCls", "ambientTsConst", "AmbientTsNs"]) {
      const r = walkBarrel(AMBIENT_TS, binding);
      expect(r.status).toBe("terminal");
      expect(r.terminalKind).toBe("type");
      expect(r.covered).toBe(false);
    }
    const control = walkBarrel(AMBIENT_TS, "realTsFn");
    expect(control.covered).toBe(true);
  });
});

describe("walkBarrel — `export type *` star hop taints (pins mutation M7)", () => {
  const TYPE_STAR = resolve(FIX, "type-star.ts");
  const TYPES = resolve(FIX, "types.ts");

  it("a runtime terminal reached through a type-only STAR hop is not covered", () => {
    const r = walkBarrel(TYPE_STAR, "realFn");
    expect(r.status).toBe("terminal");
    expect(r.terminalFile).toBe(TYPES);
    expect(r.terminalKind).toBe("function");
    expect(r.covered).toBe(false);
  });
});
