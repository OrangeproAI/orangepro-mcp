import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { computeReceiverLinks } from "../../src/local/analyze/receiverTyping.js";
import { reexportSpecifiers } from "../../src/local/analyze/reexports.js";
import { workspacePackages } from "../../src/local/analyze/confirm.js";
import { opAnalyze, opInit } from "../../src/local/operations.js";
import { loadGraph, workspacePaths } from "../../src/local/workspace.js";
import { buildWorklist, routeLinkVia } from "../../src/local/viz/worklist.js";
import { rankRiskGaps } from "../../src/local/score/risk.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "opro-receiver-"));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function run(files: Record<string, string>, counted: string[]) {
  const dir = repo(files);
  const list = Object.keys(files)
    .filter((rel) => /\.[cm]?[jt]s$/.test(rel))
    .map((rel) => ({ rel, abs: path.join(dir, rel), role: (/^test\//.test(rel) ? "test" : "source") as "test" | "source" }));
  return computeReceiverLinks({ files: list, symbols: new Set(counted), repoRoot: dir, wsPkgs: workspacePackages(dir), read: (abs) => readFileSync(abs, "utf8") });
}

// A small library shaped like Express: an entry that re-exports, a factory that copies an exported object
// onto what it returns, and request/response objects exported by name.
const LIB: Record<string, string> = {
  "package.json": JSON.stringify({ name: "kit", version: "1.0.0", main: "index.js" }),
  "index.js": "'use strict';\n\n/* entry */\nmodule.exports = require('./lib/kit');\n",
  "lib/kit.js": [
    "'use strict';",
    "var proto = require('./application');",
    "var mixin = require('./mixin');",
    "exports = module.exports = createApplication;",
    "exports.application = proto;",
    "exports.request = require('./request');",
    "exports.response = require('./response');",
    "function createApplication() {",
    "  var app = function (req, res) { app.handle(req, res); };",
    "  mixin(app, proto, false);",
    "  return app;",
    "}",
    ""
  ].join("\n"),
  "lib/mixin.js": "module.exports = function (to, from) { for (var k in from) to[k] = from[k]; return to; };\n",
  "lib/application.js": [
    "'use strict';",
    "var app = exports = module.exports = {};",
    "app.handle = function (req, res) { return res.send(req.url); };",
    "app.use = function (fn) { this.stack = (this.stack || []).concat(fn); return this; };",
    "app.set = function (k, v) { this.settings = this.settings || {}; this.settings[k] = v + 1; return this; };",
    ""
  ].join("\n"),
  "lib/response.js": "var res = Object.create(null);\nmodule.exports = res;\nres.send = function (body) { this.body = body + '!'; return this; };\n",
  "lib/request.js": "var req = Object.create(null);\nmodule.exports = req;\nreq.is = function (type) { return this.type === type + ''; };\n"
};
const COUNTED = ["sym:lib/kit.js#createApplication", "sym:lib/application.js#app.use", "sym:lib/application.js#app.set", "sym:lib/application.js#app.handle", "sym:lib/response.js#res.send", "sym:lib/request.js#req.is"];

describe("re-export files", () => {
  it("names what a file only re-exports, and nothing for a file that defines something of its own", () => {
    expect(reexportSpecifiers("'use strict';\n// x\nmodule.exports = require('./lib/kit');\n")).toEqual(["./lib/kit"]);
    expect(reexportSpecifiers("export * from './a';\nexport { b } from './b';\n")).toEqual(["./a", "./b"]);
    expect(reexportSpecifiers("module.exports = require('./lib/kit');\nexports.extra = 1;\n")).toEqual([]);
  });
});

describe("receiver typing: what links", () => {
  it("a call through the entry links the factory; members of what it returns link to the copied object; handler calls are name candidates", () => {
    const r = run(
      {
        ...LIB,
        "test/app.test.js": [
          "var kit = require('..');",
          "describe('app', function () {",
          "  it('uses', function () {",
          "    var app = kit();",
          "    app.set('a', 1);",
          "    app.use(function (req, res) { if (req.is('json')) res.send('ok'); });",
          "  });",
          "});",
          ""
        ].join("\n")
      },
      COUNTED
    );
    expect(r.links.map((l) => [l.symId, l.kind, l.value ?? null])).toEqual([
      ["sym:lib/application.js#app.set", "factory_member", "app"],
      ["sym:lib/application.js#app.use", "factory_member", "app"],
      ["sym:lib/kit.js#createApplication", "reexport_call", null]
    ]);
    expect(r.candidates.map((c) => [c.symId, c.param])).toEqual([
      ["sym:lib/request.js#req.is", "req"],
      ["sym:lib/response.js#res.send", "res"]
    ]);
    expect(r.counts.factories).toBe(1);
  });
});

describe("receiver typing: golden negatives", () => {
  it("a factory that copies an object no module exports links nothing", () => {
    const files = { ...LIB, "lib/kit.js": LIB["lib/kit.js"]!.replace("var proto = require('./application');", "var proto = { use: function () {} };") };
    const r = run({ ...files, "test/a.test.js": "var kit = require('..');\nvar app = kit();\napp.use(function () {});\n" }, COUNTED);
    expect(r.links.filter((l) => l.kind === "factory_member")).toEqual([]);
    expect(r.counts.factories).toBe(0);
  });

  it("a value given two different values in the test is not typed", () => {
    const r = run({ ...LIB, "test/a.test.js": "var kit = require('..');\nvar app = kit();\napp = {};\napp.use(function () {});\n" }, COUNTED);
    expect(r.links.filter((l) => l.kind === "factory_member")).toEqual([]);
  });

  it("a member the copied object does not have, and an object the test makes itself", () => {
    const r = run({ ...LIB, "test/a.test.js": "var kit = require('..');\nvar app = kit();\napp.missing();\nvar own = { use: function () {} };\nown.use();\n" }, COUNTED);
    expect(r.links.filter((l) => l.kind === "factory_member")).toEqual([]);
  });

  it("a direct import is left to the confirmer: only a call through a re-export links the default function", () => {
    const r = run({ ...LIB, "test/a.test.js": "var create = require('../lib/kit');\ncreate();\n" }, COUNTED);
    expect(r.links.filter((l) => l.kind === "reexport_call")).toEqual([]);
  });

  it("a re-export cycle stops", () => {
    const r = run({ "a.js": "module.exports = require('./b');\n", "b.js": "module.exports = require('./a');\n", "test/a.test.js": "var x = require('../a');\nx();\n" }, []);
    expect(r.links).toEqual([]);
  });

  it("a handler parameter whose name two exported objects share is left out", () => {
    const files = { ...LIB, "lib/other.js": "var res = Object.create(null);\nmodule.exports = res;\nres.send = function (x) { return x + 1; };\n" };
    const r = run({ ...files, "test/a.test.js": "var kit = require('..');\nvar app = kit();\napp.use(function (req, res) { res.send('x'); });\n" }, [...COUNTED, "sym:lib/other.js#res.send"]);
    expect(r.candidates.filter((c) => c.param === "res")).toEqual([]);
    expect(r.counts.handler_name_ambiguous).toBe(1);
  });
});

describe("receiver typing in the graph and the worklist", () => {
  it("analyze links the factory's members, and a handler-name match reads as Check, saying it is a match by name", () => {
    const dir = repo({
      ...LIB,
      "test/app.test.js": "const assert = require('node:assert');\nvar kit = require('..');\nit('sets', function () { var app = kit(); app.set('a', 1); app.use(function (req, res) { res.send('x'); }); assert.ok(app); });\n"
    });
    const deps = { clock: () => "2026-11-20T00:00:00.000Z", env: {} };
    opInit(dir, deps);
    opAnalyze(dir, { source: dir }, deps);
    const graph = loadGraph(workspacePaths(dir).graphPath);
    const edge = graph.edges.find((e) => e.relationship_type === "TESTED_BY" && e.from_external_id === "sym:lib/application.js#app.set");
    expect(edge).toBeDefined();
    expect(routeLinkVia(edge!.properties)).toBe("via app = createApplication() (members of lib/application.js)");
    const cand = graph.candidate_edges?.find((e) => e.from_external_id === "sym:lib/response.js#res.send" && e.to_external_id === "test:test/app.test.js");
    expect(cand?.reason.startsWith("Handler parameter res:")).toBe(true);
    const ranked = rankRiskGaps(graph, { repoRoot: dir, limit: Number.MAX_SAFE_INTEGER, includeAssociated: true });
    const rows = buildWorklist(graph, { version: 1, records: [] } as never, ranked, { provenIds: new Set(), churnWindowDays: 180 });
    const set = rows.find((r) => r.id === "sym:lib/application.js#app.set");
    const send = rows.find((r) => r.id === "sym:lib/response.js#res.send");
    if (set) expect(set).toMatchObject({ evidence: "linked", linkedVia: "via app = createApplication() (members of lib/application.js)" });
    if (send) {
      expect(send.evidence).toBe("unconfirmed");
      expect(send.reason).toContain("match by name");
    }
    expect(set ?? send).toBeDefined();
  });
});
