import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { computeRouteLinks } from "../../src/local/analyze/routeLinks.js";
import { workspacePackages } from "../../src/local/analyze/confirm.js";
import { opAnalyze, opInit } from "../../src/local/operations.js";
import { loadGraph, workspacePaths } from "../../src/local/workspace.js";
import { buildWorklist, testPointers, routeLinkVia } from "../../src/local/viz/worklist.js";
import { rankRiskGaps } from "../../src/local/score/risk.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "opro-routes-"));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function links(files: Record<string, string>, counted: string[]) {
  const dir = repo(files);
  const list = Object.keys(files)
    .filter((rel) => /\.[cm]?[jt]s$/.test(rel))
    .map((rel) => ({ rel, abs: path.join(dir, rel), role: (/^test\//.test(rel) ? "test" : "source") as "test" | "source" }));
  return computeRouteLinks({
    files: list,
    symbols: new Set(counted),
    repoRoot: dir,
    wsPkgs: workspacePackages(dir),
    read: (abs) => readFileSync(abs, "utf8")
  });
}

const CONTROLLER = "exports.getUser = function (req, res) { res.json(find(req.params.id)); };\nexports.listUsers = function (req, res) { res.json([]); };\nfunction find(id) { return { id }; }\n";
const APP = [
  "const express = require('express');",
  "const users = require('./controllers/users');",
  "const limit = require('./limit');",
  "const app = express();",
  "app.get('/users', limit, users.listUsers);",
  "app.get('/users/:id', users.getUser);",
  "module.exports = app;",
  ""
].join("\n");

describe("route links: what links", () => {
  it("a request to a traced app links its named handler; the handler is the last function, after middleware", () => {
    const r = links(
      {
        "controllers/users.js": CONTROLLER,
        "limit.js": "module.exports = function (req, res, next) { next(); };\n",
        "app.js": APP,
        "test/users.test.js": "const request = require('supertest');\nconst app = require('../app');\nit('lists', () => request(app).get('/users').expect(200));\nit('gets', () => request(app).get(`/users/${7}`).expect(200));\n"
      },
      ["sym:controllers/users.js#getUser", "sym:controllers/users.js#listUsers"]
    );
    expect(r.links.map((l) => [l.symId, l.method, l.path, l.via, l.site])).toEqual([
      ["sym:controllers/users.js#getUser", "GET", "/users/:id", "named", "app.js:6"],
      ["sym:controllers/users.js#listUsers", "GET", "/users", "named", "app.js:5"]
    ]);
    expect(r.counts).toMatchObject({ requests: 2, linked_requests: 2, links: 2 });
  });

  it("an inline handler, and one wrapped in a call, link to the counted functions they call directly, and nothing deeper", () => {
    const r = links(
      {
        "db.ts": "export function save(x: number) { return deep(x); }\nexport function deep(x: number) { return x; }\nexport function load() { return 1; }\n",
        "wrap.ts": "export const wrap = (fn: any) => fn;\n",
        "app.ts": [
          "import express from 'express';",
          "import { save, load } from './db';",
          "import { wrap } from './wrap';",
          "const app = express();",
          "app.post('/items', wrap(async (req: any, res: any) => { res.json(save(req.body.n)); }));",
          "app.get('/items', (req: any, res: any) => { res.json(load()); });",
          "export { app as handlers };",
          ""
        ].join("\n"),
        "test/items.test.ts": "import request from 'supertest';\nimport { handlers as app } from '../app';\nit('saves', () => request(app).post('/items').send({ n: 1 }));\nit('loads', () => request(app).get('/items'));\n"
      },
      ["sym:db.ts#save", "sym:db.ts#deep", "sym:db.ts#load"]
    );
    expect(r.links.map((l) => [l.symId, l.via, l.site, `${l.method} ${l.path}`])).toEqual([
      ["sym:db.ts#load", "inline", "app.ts:6", "GET /items"],
      ["sym:db.ts#save", "inline", "app.ts:5", "POST /items"]
    ]);
  });

  it("joins a router's mount prefix, through an import, and a supertest agent", () => {
    const r = links(
      {
        "controllers/users.js": CONTROLLER,
        "routes/users.js": "const express = require('express');\nconst users = require('../controllers/users');\nconst router = express.Router();\nrouter.route('/:id').get(users.getUser);\nmodule.exports = router;\n",
        "app.js": "const express = require('express');\nconst userRoutes = require('./routes/users');\nconst app = express();\napp.use('/v1/users', userRoutes);\nmodule.exports = app;\n",
        "test/users.test.js": "const request = require('supertest');\nconst app = require('../app');\nconst agent = request.agent(app);\nit('gets', () => agent.get('/v1/users/42'));\n"
      },
      ["sym:controllers/users.js#getUser"]
    );
    expect(r.links.map((l) => [l.symId, l.path])).toEqual([["sym:controllers/users.js#getUser", "/v1/users/:id"]]);
  });
});

describe("route links: golden negatives (nothing links)", () => {
  const counted = ["sym:controllers/users.js#getUser", "sym:controllers/users.js#listUsers"];
  const base = { "controllers/users.js": CONTROLLER, "limit.js": "module.exports = function (req, res, next) { next(); };\n", "app.js": APP };

  it("an app the test builds itself, as Express's own tests do, even with routes registered in the test", () => {
    const r = links(
      {
        ...base,
        "test/inline.test.js": "const express = require('express');\nconst request = require('supertest');\nconst users = require('../controllers/users');\nconst app = express();\napp.get('/users/:id', users.getUser);\nit('x', () => request(app).get('/users/1'));\n"
      },
      counted
    );
    expect(r.links).toEqual([]);
    expect(r.counts).toMatchObject({ requests: 1, app_not_traced: 1, routes: 2 });
  });

  it("a path no route has, and a full URL", () => {
    const r = links({ ...base, "test/miss.test.js": "const request = require('supertest');\nconst app = require('../app');\nit('a', () => request(app).get('/reset'));\nit('b', () => request(app).get('http://example.test/users'));\n" }, counted);
    expect(r.links).toEqual([]);
    expect(r.counts.no_route).toBe(2);
  });

  it("the same path on another app than the one the test imports", () => {
    const r = links(
      {
        ...base,
        "other.js": "const express = require('express');\nconst app = express();\nmodule.exports = app;\n",
        "test/other.test.js": "const request = require('supertest');\nconst app = require('../other');\nit('x', () => request(app).get('/users'));\n"
      },
      counted
    );
    expect(r.links).toEqual([]);
    expect(r.counts.no_route).toBe(1);
  });

  it("a wildcard route, and two routes for one path", () => {
    const r = links(
      {
        "controllers/users.js": CONTROLLER,
        "app.js": "const express = require('express');\nconst users = require('./controllers/users');\nconst app = express();\napp.get('/users', users.listUsers);\napp.get('/users', users.getUser);\napp.get('/files/*', users.getUser);\nmodule.exports = app;\n",
        "test/x.test.js": "const request = require('supertest');\nconst app = require('../app');\nit('a', () => request(app).get('/users'));\nit('b', () => request(app).get('/files/a.txt'));\n"
      },
      counted
    );
    expect(r.links).toEqual([]);
    expect(r.counts.several_routes).toBe(2);
  });

  it("routers mounted in a loop: the mount is unknown and nothing is guessed", () => {
    const r = links(
      {
        "controllers/users.js": CONTROLLER,
        "routes/users.js": "const express = require('express');\nconst users = require('../controllers/users');\nconst router = express.Router();\nrouter.get('/:id', users.getUser);\nmodule.exports = router;\n",
        "app.js": "const express = require('express');\nconst userRoutes = require('./routes/users');\nconst app = express();\nconst routes = [{ path: '/users', route: userRoutes }];\nroutes.forEach((r) => app.use(r.path, r.route));\nmodule.exports = app;\n",
        "test/u.test.js": "const request = require('supertest');\nconst app = require('../app');\nit('x', () => request(app).get('/users/1'));\n"
      },
      counted
    );
    expect(r.links).toEqual([]);
    expect(r.counts).toMatchObject({ unknown_mounts: 1, no_route: 1 });
  });

  it("a handler that is not a counted function and calls none: counted, not linked", () => {
    const r = links(
      {
        "app.js": "const express = require('express');\nconst app = express();\napp.get('/ping', (req, res) => res.send('pong'));\nmodule.exports = app;\n",
        "test/ping.test.js": "const request = require('supertest');\nconst app = require('../app');\nit('x', () => request(app).get('/ping'));\n"
      },
      []
    );
    expect(r.links).toEqual([]);
    expect(r.counts.handler_not_mapped).toBe(1);
  });

  it("a request through another HTTP client carries no app, and links nothing", () => {
    const r = links({ ...base, "test/fetch.test.js": "const app = require('../app');\nit('x', async () => { await fetch('/users'); });\n" }, counted);
    expect(r.links).toEqual([]);
    expect(r.counts.requests).toBe(0);
  });
});

describe("route links in the graph and the worklist", () => {
  it("analyze adds a Linked edge that says how it was made, and the row's reason names the route", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "svc", version: "1.0.0", main: "app.js" }),
      "controllers/users.js": CONTROLLER,
      "limit.js": "module.exports = function (req, res, next) { next(); };\n",
      "app.js": APP,
      "test/users.test.js": "const request = require('supertest');\nconst assert = require('node:assert');\nconst app = require('../app');\nit('lists', async () => { const r = await request(app).get('/users'); assert.equal(r.status, 200); });\n"
    });
    const deps = { clock: () => "2026-11-20T00:00:00.000Z", env: {} };
    opInit(dir, deps);
    opAnalyze(dir, { source: dir }, deps);
    const graph = loadGraph(workspacePaths(dir).graphPath);
    const edge = graph.edges.find((e) => e.relationship_type === "TESTED_BY" && (e.properties as { route_link?: unknown } | undefined)?.route_link);
    expect(edge).toMatchObject({ from_external_id: "sym:controllers/users.js#listUsers", to_external_id: "test:test/users.test.js", evidence_strength: "hard" });
    expect(routeLinkVia(edge!.properties)).toBe("via route GET /users (app.js:5)");
    expect(testPointers(graph).linked.get("sym:controllers/users.js#listUsers")).toEqual([{ file: "test/users.test.js", confidence: 1, via: "via route GET /users (app.js:5)" }]);
    expect(graph.analysis?.route_links).toMatchObject({ requests: 1, linked_requests: 1, links: 1 });
    const gap = rankRiskGaps(graph, { repoRoot: dir, limit: Number.MAX_SAFE_INTEGER, includeAssociated: true }).find((g) => g.id === "sym:controllers/users.js#listUsers");
    expect(gap).toBeDefined();
    const [row] = buildWorklist(graph, { version: 1, records: [] } as never, [gap!], { provenIds: new Set(), churnWindowDays: 180 });
    expect(row).toMatchObject({ evidence: "linked", verb: "prove", linkedVia: "via route GET /users (app.js:5)" });
    expect(row!.reason).toBe("test/users.test.js reaches it via route GET /users (app.js:5); not yet proven to catch a break.");
  });
});
