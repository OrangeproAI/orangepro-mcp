import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withProposedChecks, type AssocTest } from "../../src/local/autoProve.js";
import { recordSha256 } from "../../src/local/contracts/io.js";
import { ORACLE_VERSION } from "../../src/local/contracts/oracle.js";
import { PLUGIN_API_VERSION, type PluginApi } from "../../src/local/pluginApi.js";
import { proposeChecks, proposeFault, proposeOracle, publishRun, suppliedCoverage } from "../../src/local/pluginCalls.js";
import { addonInsideScannedRepo, addonProvenance, addonStatusFor, addonStatusLine, pluginsFor, setPluginHostForTest, type AddonLocation } from "../../src/local/plugins.js";

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), "opro-addon-")));

function host(mod: unknown, opts: { dir?: string; env?: NodeJS.ProcessEnv; cwd?: string; locateThrows?: boolean } = {}): { warnings: string[]; loads: () => number } {
  const warnings: string[] = [];
  let loads = 0;
  const location: AddonLocation = {
    dir: opts.dir ?? "/opt/engine/node_modules/@orangepro/mcp-pro",
    version: "9.9.9",
    load: async () => {
      loads += 1;
      if (mod instanceof Error) throw mod;
      return mod;
    }
  };
  setPluginHostForTest({
    locate: () => {
      if (opts.locateThrows) throw new Error("broken install");
      return mod === undefined ? null : location;
    },
    env: opts.env ?? {},
    cwd: () => opts.cwd ?? "/somewhere/else",
    warn: (line) => warnings.push(line)
  });
  return { warnings, loads: () => loads };
}

/** A complete fake add-on: every interface registered, every call counted. */
function fakeAddon(overrides: Partial<Record<"faults" | "oracle" | "checks" | "coverage" | "publish", (...args: any[]) => unknown>> = {}) {
  const calls: Record<string, number> = { FaultSelector: 0, OracleProposer: 0, CheckResolver: 0, RuntimeLinker: 0, PlatformClient: 0 };
  const mod = {
    pluginApiVersion: PLUGIN_API_VERSION,
    register(api: PluginApi) {
      api.registerFaultSelector({ proposeFaults: (ctx) => ((calls.FaultSelector += 1), (overrides.faults ?? (() => [{ fault: "floor_to_ceil@120", reason: "the rounding the change touched" }]))(ctx) as any) });
      api.registerOracleProposer({ proposeOracle: (ctx) => ((calls.OracleProposer += 1), (overrides.oracle ?? (() => null))(ctx) as any) });
      api.registerCheckResolver({ proposeChecks: (ctx) => ((calls.CheckResolver += 1), (overrides.checks ?? (() => []))(ctx) as any) });
      api.registerRuntimeLinker({ coverageFiles: (ctx) => ((calls.RuntimeLinker += 1), (overrides.coverage ?? (() => []))(ctx) as any) });
      api.registerPlatformClient({ publish: (ctx) => ((calls.PlatformClient += 1), (overrides.publish ?? (() => ({ ok: true, url: "https://example.invalid/run/1" })))(ctx) as any) });
    }
  };
  return { mod, calls };
}

function oracleFor(record: unknown, witness: string, approval: unknown) {
  return {
    version: ORACLE_VERSION,
    target_record_sha256: recordSha256(record),
    symbol_id: "sym:lib/a.js#f",
    behavior: "f rounds down.",
    entry_point: "f",
    inputs: "1.5",
    expected: "1",
    excluded_inputs: "none",
    why_observable: "the return value",
    basis: [{ kind: "source_doc", ref: "lib/a.js:1-3", note: "says it rounds down" }],
    witness: { file: "witness.cjs", sha256: createHash("sha256").update(witness).digest("hex"), input: "1.5" },
    assisted: { flag: false, visible_before: [] },
    approval
  };
}

afterEach(() => setPluginHostForTest(null));

describe("add-on loader", () => {
  it("with no add-on installed: empty, silent, and the status line says so", async () => {
    const h = host(undefined);
    expect(await pluginsFor("/repo")).toEqual({});
    expect(addonStatusLine(await addonStatusFor("/repo"))).toBe("pro add-on: not installed");
    expect(h.warnings).toEqual([]);
    expect(addonProvenance()).toBeUndefined();
  });

  it.each([
    ["the import throws", new Error("boom"), "it could not be loaded: boom"],
    ["no register", { pluginApiVersion: PLUGIN_API_VERSION }, "it has no register function"],
    ["no pluginApiVersion", { register() {} }, "it does not say which add-on interface version it was built for"],
    ["another major version", { pluginApiVersion: "2.0.0", register() {} }, `it was built for add-on interface 2.0.0; this engine has ${PLUGIN_API_VERSION}`],
    ["register throws", { pluginApiVersion: PLUGIN_API_VERSION, register() { throw new Error("nope"); } }, "its register function failed: nope"],
    ["a registered object lacks its method", { pluginApiVersion: PLUGIN_API_VERSION, register(api: PluginApi) { api.registerFaultSelector({} as any); } }, "its FaultSelector has no proposeFaults function"]
  ])("found but unusable (%s): defaults, one line, no throw", async (_name, mod, reason) => {
    const h = host(mod);
    expect(await pluginsFor("/repo")).toEqual({});
    expect(await pluginsFor("/repo")).toEqual({});
    expect(h.warnings).toEqual([`pro add-on: found, not used (${reason}).`]);
    expect((await addonStatusFor("/repo")).state).toBe("not_used");
  });

  it("a locate step that throws is one line and defaults", async () => {
    const h = host({}, { locateThrows: true });
    expect(await pluginsFor("/repo")).toEqual({});
    expect(h.warnings).toEqual(["pro add-on: found, not used (it could not be located: broken install)."]);
  });

  it("a same-major add-on loads once and is named only after one of its answers is used", async () => {
    const { mod } = fakeAddon();
    const h = host({ ...mod, pluginApiVersion: "1.4.2" });
    const first = await pluginsFor("/repo");
    await pluginsFor("/other");
    expect(Object.keys(first).sort()).toEqual(["checkResolver", "faultSelector", "oracleProposer", "platformClient", "runtimeLinker"]);
    expect(h.loads()).toBe(1);
    expect(addonProvenance()).toBeUndefined();
    expect(addonStatusLine(await addonStatusFor("/repo"))).toBe("pro add-on: @orangepro/mcp-pro 9.9.9 (add-on interface 1.4.2)");
  });

  it("the off switch skips an installed add-on without importing it", async () => {
    const h = host(fakeAddon().mod, { env: { ORANGEPRO_PRO: "off" } });
    expect(await pluginsFor("/repo")).toEqual({});
    expect(h.loads()).toBe(0);
    expect(h.warnings).toEqual([]);
  });

  it("an add-on inside the scanned repository is never imported", async () => {
    const repo = tmp();
    mkdirSync(join(repo, ".git"));
    const planted = join(repo, "node_modules", "@orangepro", "mcp-pro");
    mkdirSync(planted, { recursive: true });
    const sub = join(repo, "packages", "app");
    mkdirSync(sub, { recursive: true });
    for (const scanned of [repo, sub]) {
      const h = host(fakeAddon().mod, { dir: planted });
      expect(await pluginsFor(scanned)).toEqual({});
      expect(h.loads()).toBe(0);
      expect(h.warnings).toEqual(["pro add-on: found, not used (it is inside the repository being scanned)."]);
    }
    // Also when the command is started inside that repository and told to scan another folder.
    const h = host(fakeAddon().mod, { dir: planted, cwd: sub });
    expect(await pluginsFor(tmp())).toEqual({});
    expect(h.loads()).toBe(0);
    expect(addonInsideScannedRepo(planted, [tmp()])).toBe(false);
  });
});

describe("add-on call sites", () => {
  const record = { version: "x", identity: { symbol_id: "sym:lib/a.js#f" } };

  it("with no add-on every call site answers null and nothing is named", async () => {
    host(undefined);
    const root = tmp();
    expect(await proposeFault(root, root, record)).toBeNull();
    expect(await proposeOracle(root, root, join(root, ".orangepro"), record)).toBeNull();
    expect(await proposeChecks(root, root, join(root, "graph.json"))).toBeNull();
    expect(await suppliedCoverage(root, root, join(root, ".orangepro"))).toBeNull();
    expect(await publishRun(root, root, join(root, ".orangepro"), [], { ORANGEPRO_UPLOAD: "1" })).toBeNull();
    expect(addonProvenance()).toBeUndefined();
  });

  it("a fake add-on has each interface called once, and is named with what was used", async () => {
    const root = tmp();
    const ws = join(root, ".orangepro");
    mkdirSync(join(root, "test"), { recursive: true });
    mkdirSync(ws);
    writeFileSync(join(root, "test", "a.test.js"), "");
    writeFileSync(join(ws, "addon-coverage.info"), "");
    const witness = "module.exports = 1;\n";
    const { mod, calls } = fakeAddon({
      oracle: () => ({ oracle: oracleFor(record, witness, { status: "approved", by: "the add-on", at: "2026-11-19", where: "nowhere" }), witness_source: witness }),
      checks: () => [{ symbol_id: "sym:lib/a.js#f", test_file: "test/a.test.js" }, { symbol_id: "sym:lib/a.js#f", test_file: "../outside.test.js" }, { symbol_id: "sym:lib/a.js#f", test_file: "test/missing.test.js" }],
      coverage: () => [join(ws, "addon-coverage.info"), join(root, "test", "a.test.js"), "/etc/hosts"]
    });
    host(mod);

    const fault = await proposeFault(root, root, record);
    expect(fault).toMatchObject({ fault: "floor_to_ceil@120", reason: "the rounding the change touched", addon: { name: "@orangepro/mcp-pro", version: "9.9.9", used: ["FaultSelector"] } });

    const oracle = await proposeOracle(root, root, ws, record);
    expect(oracle?.oracle_path).toMatch(/^\.orangepro\/proposed-oracles\/[0-9a-f]{12}\/oracle\.json$/);
    // Whatever the add-on said, the draft is written as proposed.
    expect(JSON.parse(readFileSync(join(root, oracle!.oracle_path), "utf8")).approval).toEqual({ status: "proposed" });
    expect(readFileSync(join(root, oracle!.witness_path), "utf8")).toBe(witness);

    const checks = await proposeChecks(root, root, join(ws, "graph.json"));
    expect(checks?.proposals).toEqual([{ symbol_id: "sym:lib/a.js#f", test_file: "test/a.test.js" }]);

    const coverage = await suppliedCoverage(root, root, ws);
    expect(coverage).toEqual({ files: ["addon-coverage.info"], refused: ["/etc/hosts", join(root, "test", "a.test.js")].sort() });

    expect(await publishRun(root, root, ws, ["graph.json"], {})).toBeNull();
    expect(calls.PlatformClient).toBe(0);
    expect(await publishRun(root, root, ws, ["graph.json"], { ORANGEPRO_UPLOAD: "1" })).toEqual({ ok: true, url: "https://example.invalid/run/1" });

    expect(calls).toEqual({ FaultSelector: 1, OracleProposer: 1, CheckResolver: 1, RuntimeLinker: 1, PlatformClient: 1 });
    expect(addonProvenance()).toEqual({ name: "@orangepro/mcp-pro", version: "9.9.9", api_version: PLUGIN_API_VERSION, used: ["CheckResolver", "FaultSelector", "OracleProposer", "PlatformClient", "RuntimeLinker"] });
  });

  it.each([
    ["throws", () => { throw new Error("kaput"); }, /failed \(kaput\); ignored\.$/],
    ["hangs past the limit", () => new Promise(() => undefined), /failed \(it ran past the 0 s limit\); ignored\.$/],
    ["answers in the wrong shape", () => ({ nonsense: true }), /gave an answer in the wrong shape; ignored\.$/]
  ])("an add-on that %s at every call site counts as no answer, with one line each", async (_name, bad, line) => {
    const root = tmp();
    const { mod } = fakeAddon({ faults: bad, oracle: bad, checks: bad, coverage: bad, publish: bad });
    const h = host(mod, { env: { ORANGEPRO_PRO_TIMEOUT_MS: "30" } });
    expect(await proposeFault(root, root, record)).toBeNull();
    expect(await proposeOracle(root, root, join(root, ".orangepro"), record)).toBeNull();
    expect(await proposeChecks(root, root, "g")).toBeNull();
    expect(await suppliedCoverage(root, root, join(root, ".orangepro"))).toBeNull();
    expect(await publishRun(root, root, join(root, ".orangepro"), [], { ORANGEPRO_UPLOAD: "1" })).toBeNull();
    expect(h.warnings).toHaveLength(5);
    for (const warning of h.warnings) expect(warning).toMatch(line);
    expect(addonProvenance()).toBeUndefined();
  });

  it("a proposed expected behavior for another target, or with a witness that does not match, is not written", async () => {
    const root = tmp();
    const witness = "module.exports = 1;\n";
    for (const oracle of [oracleFor({ other: true }, witness, { status: "proposed" }), { ...oracleFor(record, witness, { status: "proposed" }), witness: { file: "w.cjs", sha256: "0".repeat(64), input: "1.5" } }]) {
      host(fakeAddon({ oracle: () => ({ oracle, witness_source: witness }) }).mod);
      expect(await proposeOracle(root, root, join(root, ".orangepro"), record)).toBeNull();
    }
  });

  it("proposed checks join the queue as weak pairs, after the engine's own links, and never for a function that is not eligible", () => {
    const node = (id: string, extra: Record<string, unknown> = {}) => ({ external_id: id, kind: "CodeSymbol", name: id.split("#")[1], denominator_eligible: true, properties: { file: id.split("#")[0]!.slice(4), kind: "function", exported: true, behavior_surface: "entrypoint_adjacent", ...extra } }) as any;
    const nodeById = new Map([["sym:lib/a.js#f", node("sym:lib/a.js#f")], ["sym:lib/b.py#g", node("sym:lib/b.py#g")]]);
    const own: AssocTest = { test: "test/own.test.js", hard: true };
    const assoc = withProposedChecks(new Map([["sym:lib/a.js#f", [own]]]), [
      { symbol_id: "sym:lib/a.js#f", test_file: "test/own.test.js" },
      { symbol_id: "sym:lib/a.js#f", test_file: "test/extra.test.js" },
      { symbol_id: "sym:lib/b.py#g", test_file: "tests/test_b.py" },
      { symbol_id: "sym:lib/none.js#h", test_file: "test/extra.test.js" }
    ], nodeById);
    expect(assoc.get("sym:lib/a.js#f")).toEqual([own, { test: "test/extra.test.js", hard: false }]);
    expect(assoc.has("sym:lib/b.py#g")).toBe(false);
    expect(assoc.has("sym:lib/none.js#h")).toBe(false);
  });
});
