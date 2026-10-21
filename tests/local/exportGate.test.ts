import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { ParseCache } from "../../src/local/analyze/parseCache.js";

// The export gate: a TS/JS function 0.2.58 does not count is counted only when
// it is public, not documented private and not trivial. Synthetic code only.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>, manifest: Record<string, unknown> = { name: "x" }): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-gate-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}
type Fragment = ReturnType<typeof analyzeRepo>;
const node = (g: Fragment, file: string, name: string) => g.nodes.find((n) => n.external_id === `sym:${file}#${name}`);
const counted = (g: Fragment, file: string): string[] =>
  g.nodes
    .filter((n) => n.kind === "CodeSymbol" && n.properties.file === file && n.denominator_eligible)
    .map((n) => n.title ?? "")
    .sort();
const calls = (g: Fragment): string[] =>
  g.edges
    .filter((e) => e.relationship_type === "CALLS")
    .map((e) => `${e.from_external_id.slice(4)} -> ${e.to_external_id.slice(4)}`)
    .sort();

// An entry file that hands its parts out the CommonJS way, and the parts.
const ENTRY = [
  "var kit = require('./lib/kit');",
  "var extras = require('./lib/extras');",
  "exports = module.exports = create;",
  "function create() { return Object.create(kit); }",
  "exports.kit = kit;",
  "exports.extras = extras;",
  ""
].join("\n");
const KIT = [
  "var kit = module.exports = {};",
  "",
  "/**",
  " * Add a header and return the total size.",
  " * @public",
  " */",
  "",
  "kit.append = function append(name, value) {",
  "  var next = this.size() + String(value).length;",
  "  this.rows.push([name, value]);",
  "  return next;",
  "};",
  "",
  "kit.set = kit.header = function header(name, value) {",
  "  this.map[name] = value;",
  "  return this;",
  "};",
  "",
  "kit.size = function () { return this.rows.length * 2; };",
  "kit.touch = function (name) { if (!this.map[name]) this.set(name, 1); return this.size(); };",
  "kit.owner = function () { return this.user; };",
  "kit.rename = function (name) { this.name = name; return this; };",
  "kit.noop = function () {};",
  "kit.total = function (rows) { return this.sum(rows); };",
  "kit.sum = function (rows) { return rows.reduce(function (a, b) { return a + b; }, 0); };",
  "kit.enable = function (name) { return this.set(name, true); };",
  "kit.isAdmin = function (user) { return user.role === 'admin'; };",
  "kit.drop = function (id) { return this.store.drop(id); };",
  "kit.later = function () { var self = this; return function () { return self.size() + this.size(); }; };",
  "kit.arrow = (name) => { return this.size(name); };",
  "",
  "/**",
  " * @private",
  " */",
  "kit.sweep = function sweep() { return this.rows.filter(Boolean).length; };",
  ""
].join("\n");

describe("counting: a library's methods handed out by its entry file", () => {
  const build = () => analyzeRepo(repo({ "index.js": ENTRY, "lib/kit.js": KIT, "lib/extras.js": "exports.pad = function (s) { return s + ' '; };\n" }, { name: "x", main: "index.js" }));

  it("counts public members that compute, compare or decide", () => {
    const g = build();
    expect(counted(g, "lib/kit.js")).toEqual(["kit.append", "kit.arrow", "kit.drop", "kit.enable", "kit.header", "kit.isAdmin", "kit.later", "kit.size", "kit.sum", "kit.touch"]);
    expect(node(g, "lib/kit.js", "kit.append")?.properties).toMatchObject({ behavior_surface: "public_api_entry", seen_by: "exported_object_method", member_of: "kit" });
    expect(node(g, "lib/kit.js", "kit.header")?.properties.aliases).toEqual(["kit.set"]);
  });

  it("leaves plumbing in the graph, uncounted, with its reason", () => {
    const g = build();
    for (const name of ["kit.owner", "kit.rename", "kit.noop", "kit.total"]) {
      const n = node(g, "lib/kit.js", name);
      expect(n?.denominator_eligible, name).toBe(false);
      expect(n?.properties.denominator_reason_code, name).toBe("trivial_body");
      expect(n?.properties.not_counted_because, name).toEqual(["trivial_body"]);
      expect(n?.properties.behavior_surface, name).toBeUndefined();
    }
  });

  it("a pass-through that adds a fixed value, or hands off to code the graph cannot see, counts", () => {
    const g = build();
    expect(node(g, "lib/kit.js", "kit.enable")?.denominator_eligible).toBe(true);
    expect(node(g, "lib/kit.js", "kit.drop")?.denominator_eligible).toBe(true);
  });

  it("leaves out a function its own JSDoc marks private", () => {
    const n = node(build(), "lib/kit.js", "kit.sweep");
    expect(n?.denominator_eligible).toBe(false);
    expect(n?.properties).toMatchObject({ denominator_reason_code: "documented_private", not_counted_because: ["documented_private"] });
  });

  it("an already-visible function that becomes public only through the entry file gets the same checks", () => {
    const g = analyzeRepo(
      repo(
        {
          "index.js": "var tools = require('./lib/tools');\nexports.tools = tools;\n",
          "lib/tools.js": "exports.label = function () { return this._label; };\nexports.shout = function (s) { return String(s).toUpperCase(); };\n"
        },
        { name: "x", main: "index.js" }
      )
    );
    expect(counted(g, "lib/tools.js")).toEqual(["shout"]);
    expect(node(g, "lib/tools.js", "label")?.properties.denominator_reason_code).toBe("trivial_body");
  });

  it("a file the entry does not hand out keeps today's result", () => {
    const g = analyzeRepo(repo({ "index.js": ENTRY, "lib/kit.js": KIT, "lib/extras.js": "exports.pad = function (s) { return s + ' '; };\n", "lib/inner.js": "/** @private */\nexports.peek = function () { return this.x; };\n" }, { name: "x", main: "index.js" }));
    const n = node(g, "lib/inner.js", "peek");
    expect(n?.denominator_eligible).toBe(false);
    expect(n?.properties.denominator_reason_code).toBe("not_entry_point_adjacent");
    expect(n?.properties.not_counted_because).toBeUndefined();
  });
});

describe("the entry-file rule is followed only when it can be read without guessing", () => {
  // `twice` matches no behavior-like name rule, so it counts only when its file is public.
  const part = "var part = module.exports = {};\npart.twice = function (a) { return a * 2; };\n";
  const countedPart = (entry: string): string[] => counted(analyzeRepo(repo({ "index.js": entry, "lib/part.js": part }, { name: "x", main: "index.js" })), "lib/part.js");

  it("follows `exports.name = require()` directly, through a variable bound once, and again in the file it reaches", () => {
    expect(countedPart("exports.part = require('./lib/part');\n")).toEqual(["part.twice"]);
    expect(countedPart("module.exports.part = require('./lib/part');\n")).toEqual(["part.twice"]);
    expect(countedPart("var part = require('./lib/part');\nfunction make(part) { return part; }\nexports.part = part;\n")).toEqual(["part.twice"]);
    const g = analyzeRepo(repo({ "index.js": "exports.mid = require('./lib/mid');\n", "lib/mid.js": "exports.part = require('./part');\n", "lib/part.js": part }, { name: "x", main: "index.js" }));
    expect(counted(g, "lib/part.js")).toEqual(["part.twice"]);
  });

  it("does not follow a write that cannot reach the exported object", () => {
    expect(countedPart("exports.part = require('./lib/part');\nmodule.exports = function make() { return 1; };\n")).toEqual([]);
    expect(countedPart("var part = require('./lib/part');\npart = wrap(part);\nexports.part = part;\n")).toEqual([]);
    expect(countedPart("exports.twice = require('./lib/part').twice;\n")).toEqual([]);
  });

  it("reports the re-export spellings it does not follow", () => {
    const g = analyzeRepo(repo({ "index.js": "module.exports = { part: require('./lib/part') };\n", "lib/part.js": part }, { name: "x", main: "index.js" }));
    expect(counted(g, "lib/part.js")).toEqual([]);
    expect(g.analysis?.not_supported?.files["index.js"]).toEqual([{ code: "public_reexport_not_followed", name: "./lib/part", start_line: 1, end_line: 1 }]);
    const property = analyzeRepo(repo({ "index.js": "module.exports = require('./lib/part').default;\n", "lib/part.js": part }, { name: "x", main: "index.js" }));
    expect(property.analysis?.not_supported?.files["index.js"]).toEqual([{ code: "public_reexport_not_followed", name: "./lib/part", start_line: 1, end_line: 1 }]);
    // `var exports = module.exports = {}` keeps `exports` attached; a write on an unrelated local object hands nothing out.
    const rebound = analyzeRepo(repo({ "index.js": "var exports = module.exports = {};\nexports.part = require('./lib/part');\n", "lib/part.js": part }, { name: "x", main: "index.js" }));
    expect(counted(rebound, "lib/part.js")).toEqual(["part.twice"]);
    const unrelated = analyzeRepo(repo({ "index.js": "var cache = {};\ncache.part = require('./lib/part');\nexports.size = function () { return Object.keys(cache).length; };\n", "lib/part.js": part }, { name: "x", main: "index.js" }));
    expect(unrelated.analysis?.not_supported).toBeUndefined();
    const typeOnly = analyzeRepo(repo({ "index.ts": "import type { Part } from './lib/kinds';\nexport { Part };\nexport function size(p: Part) { return p.items.length; }\n", "lib/kinds.ts": "export interface Part { items: string[] }\n" }, { name: "x", main: "index.ts" }));
    expect(typeOnly.analysis?.not_supported).toBeUndefined();
    const esm = analyzeRepo(repo({ "index.js": "import part from './lib/part.js';\nimport * as more from './lib/more.js';\nexport { more };\nexport default part;\n", "lib/part.js": part, "lib/more.js": part }, { name: "x", main: "index.js" }));
    expect(esm.analysis?.not_supported?.files["index.js"]).toEqual([{ code: "public_reexport_not_followed", name: "./lib/more.js, ./lib/part.js", start_line: 3, end_line: 4 }]);
  });
});

describe("what 0.2.58 already counts is untouched", () => {
  it("a getter-shaped function in a route file stays counted", () => {
    const g = analyzeRepo(repo({ "src/routes/users.ts": "let current = 1;\n/** @internal */\nexport function getUser() { return current; }\n" }));
    const n = node(g, "src/routes/users.ts", "getUser");
    expect(n?.denominator_eligible).toBe(true);
    expect(n?.properties.denominator_reason_code).toBeUndefined();
    expect(n?.properties.not_counted_because).toBeUndefined();
  });

  it("every public name is tried: an export list alias counts like the declared name", () => {
    const g = analyzeRepo(repo({ "src/core.ts": "function impl(input: string) { return input.trim().length > 0; }\nfunction plain(input: string) { return input.trim(); }\nexport { impl as createUser, plain as tidy };\n" }));
    expect(counted(g, "src/core.ts")).toEqual(["impl"]);
    expect(node(g, "src/core.ts", "impl")?.properties).toMatchObject({ behavior_surface: "entrypoint_adjacent", seen_by: "export_list", aliases: ["createUser"] });
    expect(node(g, "src/core.ts", "plain")?.properties.denominator_reason_code).toBe("not_entry_point_adjacent");
  });
});

describe("call links for the newly visible functions", () => {
  it("links `this.name()` between members, through aliases, and not through an arrow or a nested function", () => {
    const g = analyzeRepo(repo({ "index.js": ENTRY, "lib/kit.js": KIT, "lib/extras.js": "exports.pad = function (s) { return s + ' '; };\n" }, { name: "x", main: "index.js" }));
    const fromKit = calls(g).filter((c) => c.startsWith("lib/kit.js#"));
    expect(fromKit).toEqual([
      "lib/kit.js#kit.enable -> lib/kit.js#kit.header", // this.set → alias of kit.header
      "lib/kit.js#kit.total -> lib/kit.js#kit.sum",
      "lib/kit.js#kit.touch -> lib/kit.js#kit.header",
      "lib/kit.js#kit.touch -> lib/kit.js#kit.size"
    ]);
    // kit.append calls this.size() inside a local variable declaration: today's linker drops that call.
    // kit.later reaches this.size() only inside a nested function; kit.arrow has no `this` of its own.
  });

  it("an inline function of the exported literal is bound by position, never by its name", () => {
    const g = analyzeRepo(
      repo({
        "src/routes/items.js": [
          "function helper(q) { return q.limit; }",
          "module.exports = {",
          "  count(q) { return this.pick(q) + helper(q); },",
          "  pick(q) { return q.limit * 2; },",
          "  fetch(q) { return fetch('/items?' + q.limit); },",
          "  first(q) { return fetch(q); }",
          "};",
          ""
        ].join("\n")
      })
    );
    expect(counted(g, "src/routes/items.js")).toEqual(["count", "fetch", "first", "pick"]);
    // `this.pick()` links to the sibling property; the free call `fetch()` is the global, not the property.
    expect(calls(g)).toEqual(["src/routes/items.js#count -> src/routes/items.js#pick"]);
  });

  it("a function written `exports.name = function` still has no outgoing links", () => {
    const g = analyzeRepo(repo({ "src/routes/a.js": "exports.run = function () { return stop(); };\nexports.stop = function () { return 1; };\n" }));
    expect(calls(g)).toEqual([]);
  });

  it("an import by an exported alias resolves to the aliased function", () => {
    const g = analyzeRepo(
      repo({
        "src/services/impl.ts": "function impl(a: number) { return a > 1 ? a : 0; }\nexport { impl as run };\n",
        "src/routes/use.ts": "import { run } from '../services/impl';\nexport function handle(a: number) { return run(a) + 1; }\n"
      })
    );
    expect(calls(g)).toEqual(["src/routes/use.ts#handle -> src/services/impl.ts#impl"]);
  });

  it("a static call is never linked to the prototype method of the same name", () => {
    const g = analyzeRepo(
      repo({
        "src/services/box.js": [
          "export function Box(items) { this.items = items; }",
          "Box.compare = function (a, b) { return a.items.length - b.items.length; };",
          "Box.prototype.compare = function (other) { return this.items.length === other.items.length; };",
          "Box.prototype.same = function (other) { return Box.compare(this, other) === 0; };",
          "export function order(a, b) { return Box.compare(a, b); }",
          ""
        ].join("\n")
      })
    );
    expect(node(g, "src/services/box.js", "Box.compare")?.properties).toMatchObject({ seen_by: "prototype_method", start_line: 3 });
    expect(calls(g)).toEqual([]);
  });

  it("an import is answered by the function exported under that name, not by a local that happens to share it", () => {
    const g = analyzeRepo(
      repo({
        "src/services/parse.js": "function parse(input) { return JSON.parse(input); }\nfunction parseLoose(input) { try { return JSON.parse(input); } catch (e) { return null; } }\nexport { parseLoose as parse, parse as parseStrict };\n",
        "src/routes/load.js": "import { parse } from '../services/parse.js';\nexport function load(text) { return parse(text); }\n"
      })
    );
    expect(calls(g)).toEqual(["src/routes/load.js#load -> src/services/parse.js#parseLoose"]);
  });

  it("`this.name()` in an exported literal reaches a sibling written as a reference", () => {
    const g = analyzeRepo(
      repo({ "src/routes/report.js": "function total(rows) { return rows.length * 2; }\nmodule.exports = { total, sum: total, report(rows) { return this.total(rows) + this.sum(rows); } };\n" })
    );
    expect(calls(g)).toEqual(["src/routes/report.js#report -> src/routes/report.js#total"]);
  });

  it("a newly visible caller is not linked to a symbol that is only an export key", () => {
    const g = analyzeRepo(
      repo({ "src/routes/mail.js": "exports.send = function (m) { return m.to.length > 0; };\nfunction queue(m) { return send(m); }\nexport { queue };\n" })
    );
    expect(calls(g)).toEqual([]); // `send()` is not `exports.send`
  });

  it("a pass-through to a private function that shares an export key's name still counts", () => {
    const g = analyzeRepo(
      repo(
        {
          "index.js": "function check(o) { return o.items.length > 0 && o.total > 0; }\nexports.check = function (o) { return o.ok === true; };\nfunction validate(o) { return check(o); }\nexport { validate };\n"
        },
        { name: "x", main: "index.js" }
      )
    );
    expect(node(g, "index.js", "validate")?.denominator_eligible).toBe(true); // it calls the private `check`, not `exports.check`
  });

  it("no caller identity is taken from a parse that failed (JSX in a .js file)", () => {
    const page = "import { track } from './track.js';\nexport function render(e) { return e.id > 0; }\nexport default function (e) {\n  track(e);\n  return <p>{render(e) && <b>it's on</b>}</p>;\n}\n";
    const files = (name: string) => ({ [`src/routes/${name}`]: page, "src/routes/track.js": "export function track(e) { return e.type.length > 0; }\n" });
    expect(calls(analyzeRepo(repo(files("page.js"))))).toEqual([]);
    expect(calls(analyzeRepo(repo(files("page.jsx"))))).toEqual(["src/routes/page.jsx#default -> src/routes/page.jsx#render", "src/routes/page.jsx#default -> src/routes/track.js#track"]);
  });

  it("the unnamed default speaks as `default`", () => {
    const g = analyzeRepo(
      repo({ "src/routes/ping.ts": "export function check(a: number) { return a > 0; }\nexport default async function (a: number) { return check(a) ? 'up' : 'down'; }\n" })
    );
    expect(calls(g)).toEqual(["src/routes/ping.ts#default -> src/routes/ping.ts#check"]);
    expect(node(g, "src/routes/ping.ts", "default")?.denominator_eligible).toBe(true);
  });
});

describe("not-supported shapes are disclosed in the analysis", () => {
  it("lists them per file with a total and a count per code, and omits the block when there are none", () => {
    const g = analyzeRepo(
      repo({
        "lib/a.js": "var a = module.exports = {};\nfunction define(o, n, f) { Object.defineProperty(o, n, { get: f }); }\ndefine(a, 'size', function () { return 1; });\n",
        "lib/b.js": "module.exports = function () { return 1; };\n"
      })
    );
    expect(g.analysis?.not_supported).toEqual({
      total: 2,
      by_code: { helper_defined: 1, unnamed_export: 1 },
      files: {
        "lib/a.js": [{ code: "helper_defined", owner: "a", name: "size", start_line: 3, end_line: 3 }],
        "lib/b.js": [{ code: "unnamed_export", start_line: 1, end_line: 1 }]
      }
    });
    expect(analyzeRepo(repo({ "src/a.ts": "export function a() { return 1; }\n" })).analysis?.not_supported).toBeUndefined();
  });
});

describe("a warm parse cache gives the same answer as a cold one", () => {
  it("symbols, counting, reasons, links and the not-supported list are identical", () => {
    const root = repo({ "index.js": ENTRY, "lib/kit.js": KIT, "lib/extras.js": "module.exports = function () { return 1; };\n" }, { name: "x", main: "index.js" });
    const cold = new ParseCache();
    const first = analyzeRepo(root, { readContent: true, parseCache: cold });
    const warm = new ParseCache(JSON.parse(JSON.stringify(cold.toData()))); // persist → reload
    const second = analyzeRepo(root, { readContent: true, parseCache: warm });
    expect(warm.misses).toBe(0);
    const view = (g: Fragment) => ({
      symbols: g.nodes
        .filter((n) => n.kind === "CodeSymbol")
        .map((n) => [n.external_id, n.denominator_eligible, n.properties.denominator_reason_code ?? null, n.properties.seen_by ?? null, n.properties.aliases ?? null]),
      calls: calls(g),
      not_supported: g.analysis?.not_supported
    });
    expect(view(second)).toEqual(view(first));
    expect(first.analysis?.not_supported?.by_code).toEqual({ unnamed_export: 1 });
  });
});
