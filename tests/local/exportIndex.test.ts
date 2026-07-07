import { describe, it, expect, beforeEach } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildExportIndex,
  resetExportIndexCache,
  type ReExportNamed
} from "../../src/local/resolve/exportIndex.js";

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), "__fixtures__/barrel");
const DEFS = resolve(FIX, "defs.ts");
const INDEX = resolve(FIX, "index.ts");
const PLAIN = resolve(FIX, "plain.ts");
const LOCAL_REEXPORT = resolve(FIX, "local-reexport.ts");
const REEXPORT_IMPORTED = resolve(FIX, "reexport-imported.ts");
const AMBIG_INDEX = resolve(FIX, "ambig/index.ts");

beforeEach(() => {
  resetExportIndexCache();
});

const named = (re: { kind: string }): re is ReExportNamed => re.kind === "named";

describe("buildExportIndex — local definitions", () => {
  it("records locally-defined exports with their kind and ignores non-exported decls", () => {
    const idx = buildExportIndex(DEFS);
    expect(idx.local.get("saveUser")).toBe("function");
    expect(idx.local.get("deleteUser")).toBe("function");
    expect(idx.local.get("Model")).toBe("type");
    expect(idx.local.has("internalHelper")).toBe(false); // declared but not exported
    expect(idx.isBarrel).toBe(false);
    expect(idx.reexports).toHaveLength(0);
  });

  it("a plain module with no re-exports is not a barrel", () => {
    const idx = buildExportIndex(PLAIN);
    expect(idx.isBarrel).toBe(false);
    expect(idx.local.get("plain")).toBe("function");
    expect(idx.local.get("PLAIN_CONST")).toBe("const");
  });

  it("`export { x }` (no from) of a LOCAL binding stays local with the decl's kind", () => {
    const idx = buildExportIndex(LOCAL_REEXPORT);
    expect(idx.local.get("localFn")).toBe("function");
    expect(idx.isBarrel).toBe(false); // no `from` -> not a re-export
  });
});

describe("buildExportIndex — re-exports / barrels", () => {
  it("captures star + named + aliased re-exports and marks the file a barrel", () => {
    const idx = buildExportIndex(INDEX);
    expect(idx.isBarrel).toBe(true);
    expect(idx.local.size).toBe(0);

    const stars = idx.reexports.filter((r) => r.kind === "star");
    expect(stars).toHaveLength(1);
    expect(stars[0].specifier).toBe("./defs.js");

    const nameds = idx.reexports.filter(named);
    const byExported = new Map<string, { specifier: string; source: string }>();
    for (const re of nameds) for (const n of re.names) byExported.set(n.exported, { specifier: re.specifier, source: n.source });
    // `export { fetchData } from "./more.js"`
    expect(byExported.get("fetchData")).toEqual({ specifier: "./more.js", source: "fetchData" });
    // `export { saveUser as storeUser } from "./defs.js"` -> exported storeUser <- source saveUser
    expect(byExported.get("storeUser")).toEqual({ specifier: "./defs.js", source: "saveUser" });
  });

  it("`export { x }` (no from) of an IMPORTED binding becomes a named re-export to follow", () => {
    const idx = buildExportIndex(REEXPORT_IMPORTED);
    expect(idx.isBarrel).toBe(true); // synthesized re-export -> behaves like a barrel hop
    expect(idx.local.has("saveUser")).toBe(false); // NOT terminal here
    const nameds = idx.reexports.filter(named);
    expect(nameds).toHaveLength(1);
    expect(nameds[0].specifier).toBe("./defs.js");
    expect(nameds[0].names).toEqual([{ source: "saveUser", exported: "saveUser", isTypeOnly: false }]);
  });

  it("two star re-exports are both captured", () => {
    const idx = buildExportIndex(AMBIG_INDEX);
    const stars = idx.reexports.filter((r) => r.kind === "star");
    expect(stars.map((s) => s.specifier).sort()).toEqual(["./star1.js", "./star2.js"]);
  });
});

describe("buildExportIndex — caching", () => {
  it("memoizes by path+mtime and resets on demand", () => {
    const a = buildExportIndex(DEFS);
    const b = buildExportIndex(DEFS);
    expect(a).toBe(b); // same object from cache
    resetExportIndexCache();
    const c = buildExportIndex(DEFS);
    expect(c).not.toBe(a); // rebuilt after reset
    expect(c.local.get("saveUser")).toBe("function");
  });

  it("returns an empty index for an unreadable file (no throw)", () => {
    const idx = buildExportIndex(resolve(FIX, "does-not-exist.ts"));
    expect(idx.local.size).toBe(0);
    expect(idx.reexports).toHaveLength(0);
    expect(idx.isBarrel).toBe(false);
  });
});

describe("buildExportIndex — type-only tracking", () => {
  const TYPES = resolve(FIX, "types.ts");
  const TYPE_REEXPORT = resolve(FIX, "type-reexport.ts");
  const ELEMENT_TYPE = resolve(FIX, "element-type.ts");

  it("records type definitions with kind 'type' and runtime defs with their kind", () => {
    const idx = buildExportIndex(TYPES);
    expect(idx.local.get("realFn")).toBe("function");
    expect(idx.local.get("Shape")).toBe("type");
    expect(idx.local.get("Model")).toBe("type");
  });

  it("marks `export type { ... } from` names as type-only", () => {
    const idx = buildExportIndex(TYPE_REEXPORT);
    const nameds = idx.reexports.filter(named);
    const flat = nameds.flatMap((re) => re.names);
    expect(flat.every((n) => n.isTypeOnly)).toBe(true);
    expect(flat.map((n) => n.exported).sort()).toEqual(["Model", "realFn"]);
  });

  it("marks only the `type`-prefixed element of `export { type X, y } from`", () => {
    const idx = buildExportIndex(ELEMENT_TYPE);
    const flat = idx.reexports.filter(named).flatMap((re) => re.names);
    const byName = new Map(flat.map((n) => [n.exported, n.isTypeOnly]));
    expect(byName.get("Model")).toBe(true);
    expect(byName.get("realFn")).toBe(false);
  });
});

describe("buildExportIndex — namespace instantiation", () => {
  const NS_KINDS = resolve(FIX, "ns-kinds.ts");

  it("only an INSTANTIATED namespace gets the runtime 'namespace' kind", () => {
    const idx = buildExportIndex(NS_KINDS);
    expect(idx.local.get("HasValue")).toBe("namespace"); // has a const member
    expect(idx.local.get("NestedValue")).toBe("namespace"); // instantiated via nested value
    expect(idx.local.get("TypesOnly")).toBe("type"); // interfaces/aliases only -> erased
    expect(idx.local.get("AmbientNs")).toBe("type"); // `declare namespace` -> erased
  });
});

describe("buildExportIndex — ambient `declare` in a regular .ts file is types-only", () => {
  const AMBIENT_TS = resolve(FIX, "ambient-ts.ts");

  it("export declare function/class/const/namespace all get kind 'type'; real decls keep theirs", () => {
    const idx = buildExportIndex(AMBIENT_TS);
    expect(idx.local.get("ambientTsFn")).toBe("type");
    expect(idx.local.get("AmbientTsCls")).toBe("type");
    expect(idx.local.get("ambientTsConst")).toBe("type");
    expect(idx.local.get("AmbientTsNs")).toBe("type");
    expect(idx.local.get("realTsFn")).toBe("function"); // control
  });
});
