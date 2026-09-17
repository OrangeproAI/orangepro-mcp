import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";
import { LOCAL_GRAPH_SCHEMA_VERSION, type LocalGraph } from "../../src/local/graph/ontology.js";
import { rankRiskGaps } from "../../src/local/score/risk.js";

const dirs: string[] = [];

beforeAll(async () => {
  await preloadTreeSitter(["python"]);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "opro-python-structural-"));
  dirs.push(root);
  writeFileSync(join(root, "pyproject.toml"), "[project]\nname = 'python-structural-fixture'\nversion = '0.0.0'\n");
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function toGraph(fragment: ReturnType<typeof analyzeRepo>, root: string): LocalGraph {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "python-structural-fixture", root, root_hash: "fixture-root", source_upload_policy: "metadata_only" },
    created_at: timestamp,
    updated_at: timestamp,
    sources: fragment.sources,
    nodes: fragment.nodes,
    edges: fragment.edges,
    candidate_edges: fragment.candidate_edges,
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: timestamp, git: null, files: fragment.file_entries },
    analysis: fragment.analysis
  };
}

describe("Python structural credibility", () => {
  it("owner-qualifies same-named methods and resolves self calls to the correct owner", () => {
    const root = repo({
      "src/services.py": [
        "class AlphaService:",
        "    def run(self):",
        "        return 1",
        "    def execute(self):",
        "        return self.run()",
        "",
        "class BetaService:",
        "    def run(self):",
        "        return 2",
        "    def execute(self):",
        "        return self.run()",
        "",
        "class OuterA:",
        "    class Inner:",
        "        def run(self):",
        "            return 3",
        "",
        "class OuterB:",
        "    class Inner:",
        "        def run(self):",
        "            return 4",
        "",
        "class DecoratedService:",
        "    @classmethod",
        "    async def run(cls):",
        "        return 5",
        "",
        "def outer():",
        "    def local_only():",
        "        return 6",
        "    return local_only()"
      ].join("\n")
    });
    const fragment = analyzeRepo(root, { readContent: true });
    const ids = new Set(fragment.nodes.filter((n) => n.kind === "CodeSymbol").map((n) => n.external_id));

    expect(ids.has("sym:src/services.py#AlphaService.run")).toBe(true);
    expect(ids.has("sym:src/services.py#BetaService.run")).toBe(true);
    expect(ids.has("sym:src/services.py#OuterA.Inner")).toBe(true);
    expect(ids.has("sym:src/services.py#OuterB.Inner")).toBe(true);
    expect(ids.has("sym:src/services.py#OuterA.Inner.run")).toBe(true);
    expect(ids.has("sym:src/services.py#OuterB.Inner.run")).toBe(true);
    expect(ids.has("sym:src/services.py#DecoratedService.run")).toBe(true);
    expect(ids.has("sym:src/services.py#run")).toBe(false);
    expect(ids.has("sym:src/services.py#local_only")).toBe(false);
    expect(fragment.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from_external_id: "sym:src/services.py#AlphaService.execute", to_external_id: "sym:src/services.py#AlphaService.run", relationship_type: "CALLS" }),
      expect.objectContaining({ from_external_id: "sym:src/services.py#BetaService.execute", to_external_id: "sym:src/services.py#BetaService.run", relationship_type: "CALLS" })
    ]));
  });

  it("extracts FastAPI decorators and add_api_route, composes local prefixes, links Depends, and promotes exact endpoint reachability", () => {
    const root = repo({
      "src/api/routes.py": [
        "from fastapi import APIRouter, FastAPI, Depends",
        "from src.auth import authenticate",
        "from src.core.domain import DomainModel",
        "from src.api.container import RankedContainer",
        "from src.internal.helpers import _private",
        "",
        "router = APIRouter(prefix='/v1')",
        "app = FastAPI()",
        "",
        "@router.get('/items')",
        "@router.post('/items')",
        "async def items(user = Depends(authenticate)):",
        "    return _private(user), DomainModel.hydrate(user), RankedContainer.process(user)",
        "",
        "router.add_api_route('/named', items, methods=['GET', 'POST'])",
        "app.include_router(router, prefix='/api')",
        "",
        "@app.get('/health')",
        "def health():",
        "    return {'ok': True}"
      ].join("\n"),
      "src/auth.py": "def authenticate():\n    return True\n",
      "src/internal/helpers.py": "def _private(value):\n    return value\n",
      "src/core/domain.py": [
        "class DomainModel:",
        "    @staticmethod",
        "    def hydrate(value):",
        "        return value"
      ].join("\n"),
      "src/api/container.py": [
        "class RankedContainer:",
        "    @staticmethod",
        "    def process(value):",
        "        return value"
      ].join("\n")
    });
    const fragment = analyzeRepo(root, { readContent: true });
    const endpoints = fragment.nodes.filter((n) => n.kind === "Endpoint");
    const titles = endpoints.map((n) => n.title).sort();

    expect(titles).toEqual(["GET /api/v1/items", "GET /api/v1/named", "GET /health", "POST /api/v1/items", "POST /api/v1/named"]);
    expect(endpoints.every((n) => n.properties.framework === "fastapi")).toBe(true);
    expect(endpoints.filter((n) => n.title !== "GET /health").every((n) => n.properties.route_prefix_status === "resolved")).toBe(true);
    expect(fragment.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationship_type: "IMPLEMENTED_IN", to_external_id: "sym:src/api/routes.py#items" }),
      expect.objectContaining({ relationship_type: "DEPENDS_ON", to_external_id: "sym:src/auth.py#authenticate" }),
      expect.objectContaining({ from_external_id: "sym:src/api/routes.py#items", to_external_id: "sym:src/auth.py#authenticate", relationship_type: "CALLS", evidence_strength: "framework-derived" }),
      expect.objectContaining({ from_external_id: "sym:src/api/routes.py#items", to_external_id: "sym:src/core/domain.py#DomainModel.hydrate", relationship_type: "CALLS" }),
      expect.objectContaining({ from_external_id: "sym:src/api/routes.py#items", to_external_id: "sym:src/api/container.py#RankedContainer.process", relationship_type: "CALLS" })
    ]));
    expect(fragment.nodes.find((n) => n.external_id === "sym:src/api/routes.py#items")?.properties.denominator_witness)
      .toEqual({ seed: "sym:src/api/routes.py#items", edge_kinds: [], hop_count: 0 });
    const hydrate = fragment.nodes.find((n) => n.external_id === "sym:src/core/domain.py#DomainModel.hydrate");
    const privateHelper = fragment.nodes.find((n) => n.external_id === "sym:src/internal/helpers.py#_private");
    const container = fragment.nodes.find((n) => n.external_id === "sym:src/api/container.py#RankedContainer");
    expect(hydrate).toMatchObject({
      denominator_eligible: true,
      denominator_reason: "Transitively reachable from a Python framework entrypoint through exact static calls.",
      properties: expect.objectContaining({
        denominator_witness: {
          seed: "sym:src/api/routes.py#items",
          edge_kinds: ["CALLS"],
          hop_count: 1
        }
      })
    });
    expect(privateHelper).toMatchObject({
      denominator_eligible: false,
      properties: expect.objectContaining({ denominator_witness: { seed: "sym:src/api/routes.py#items", edge_kinds: ["CALLS"], hop_count: 1 } })
    });
    expect(container).toMatchObject({ denominator_eligible: true, properties: expect.objectContaining({ ranking_exclusion_reason: "python_structural_container" }) });
    const rankedIds = rankRiskGaps(toGraph(fragment, root), { repoRoot: root, limit: 100 }).map((r) => r.id);
    expect(rankedIds).toContain(hydrate?.external_id);
    expect(rankedIds).not.toContain(container?.external_id);
    expect(fragment.analysis.python_structural_recalibration).toMatchObject({ dependency_edges: 4 });
    expect(fragment.analysis.python_structural_recalibration?.structural_containers_rank_excluded).toBeGreaterThanOrEqual(1);
  });

  it("extracts api_route methods and dependency lists without treating on_event as an endpoint", () => {
    const root = repo({
      "src/api.py": [
        "from fastapi import APIRouter, Depends, Security",
        "router = APIRouter()",
        "def auth():",
        "    return True",
        "@router.api_route('/bulk', methods=['PUT', 'DELETE'], dependencies=[Security(auth)])",
        "def bulk():",
        "    return True",
        "def named():",
        "    return True",
        "router.add_api_route('/named', named, methods=['GET'], dependencies=[Depends(auth)])",
        "OTHER = 'POST'",
        "@router.api_route('/mixed', methods=['GET', OTHER])",
        "def mixed():",
        "    return True",
        "router.add_api_route('/mixed-named', named, methods=['GET', OTHER])",
        "def ordinary(dep = Depends(auth)):",
        "    return dep",
        "def factory():",
        "    nested = APIRouter()",
        "    @nested.get('/nested')",
        "    def nested_handler():",
        "        return True",
        "    return nested",
        "def build_routes():",
        "    @router.get('/nested-existing')",
        "    def nested_existing():",
        "        return True",
        "if False:",
        "    dead = APIRouter()",
        "    @dead.get('/dead')",
        "    def dead_handler():",
        "        return True",
        "shadow = APIRouter()",
        "shadow = object()",
        "@shadow.get('/wrong')",
        "def wrong():",
        "    return True",
        "@router.on_event('startup')",
        "def startup():",
        "    return None"
      ].join("\n")
    });
    const fragment = analyzeRepo(root, { readContent: true });
    expect(fragment.nodes.filter((n) => n.kind === "Endpoint").map((n) => n.title).sort())
      .toEqual(["DELETE /bulk", "GET /named", "PUT /bulk"]);
    expect(fragment.edges.filter((e) => e.relationship_type === "DEPENDS_ON" && e.to_external_id === "sym:src/api.py#auth")).toHaveLength(3);
    expect(fragment.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from_external_id: "sym:src/api.py#bulk", to_external_id: "sym:src/api.py#auth", relationship_type: "CALLS", evidence_strength: "framework-derived" }),
      expect.objectContaining({ from_external_id: "sym:src/api.py#named", to_external_id: "sym:src/api.py#auth", relationship_type: "CALLS", evidence_strength: "framework-derived" })
    ]));
    expect(fragment.edges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ from_external_id: "sym:src/api.py#ordinary", to_external_id: "sym:src/api.py#auth", relationship_type: "CALLS" })
    ]));
  });

  it("marks unresolved APIRouter composition explicitly instead of inventing a prefix", () => {
    const root = repo({
      "src/api/routes.py": [
        "from fastapi import APIRouter",
        "router = APIRouter(prefix='/v1')",
        "@router.get('/items')",
        "def items():",
        "    return []"
      ].join("\n")
    });
    const endpoint = analyzeRepo(root, { readContent: true }).nodes.find((n) => n.kind === "Endpoint");
    expect(endpoint).toMatchObject({
      title: "GET /v1/items",
      properties: expect.objectContaining({ route_prefix_status: "unresolved", route_prefix: "/v1" })
    });
  });

  it("does not invent a dynamic APIRouter prefix", () => {
    const root = repo({
      "src/api/routes.py": [
        "from fastapi import APIRouter",
        "API_PREFIX = load_prefix()",
        "router = APIRouter(prefix=API_PREFIX)",
        "@router.get('/items')",
        "def items():",
        "    return []"
      ].join("\n")
    });
    const endpoint = analyzeRepo(root, { readContent: true }).nodes.find((n) => n.kind === "Endpoint");
    expect(endpoint).toMatchObject({ title: "GET /items", properties: expect.objectContaining({ route_prefix_status: "unresolved" }) });
    expect(endpoint?.properties.route_prefix).toBeUndefined();
  });

  it("does not treat a FastAPI constructor prefix argument as a route prefix", () => {
    const root = repo({
      "src/app.py": [
        "from fastapi import FastAPI",
        "app = FastAPI(prefix='/not-a-route-prefix')",
        "@app.get('/items')",
        "def items():",
        "    return []"
      ].join("\n")
    });
    const endpoint = analyzeRepo(root, { readContent: true }).nodes.find((n) => n.kind === "Endpoint");
    expect(endpoint).toMatchObject({ title: "GET /items", properties: expect.objectContaining({ route_prefix_status: "resolved" }) });
    expect(endpoint?.properties.route_prefix).toBeUndefined();
  });

  it("keeps endpoint identities distinct when source paths slugify to the same text", () => {
    const root = repo({
      "src/a-b.py": ["from fastapi import APIRouter", "router = APIRouter()", "@router.get('/same')", "def run():", "    return 1"].join("\n"),
      "src/a/b.py": ["from fastapi import APIRouter", "router = APIRouter()", "@router.get('/same')", "def run():", "    return 2"].join("\n")
    });
    const endpoints = analyzeRepo(root, { readContent: true }).nodes.filter((n) => n.kind === "Endpoint");
    expect(endpoints).toHaveLength(2);
    expect(new Set(endpoints.map((n) => n.external_id)).size).toBe(2);
  });

  it("rejects routes whose receiver binding is late, conditional, deleted, augmented, or destructured", () => {
    const root = repo({
      "src/adversarial.py": [
        "from fastapi import APIRouter",
        "@late.get('/late')",
        "def late_handler(): return True",
        "late = APIRouter()",
        "conditional = None",
        "if False:",
        "    conditional = APIRouter()",
        "@conditional.get('/conditional')",
        "def conditional_handler(): return True",
        "deleted = APIRouter()",
        "del deleted",
        "@deleted.get('/deleted')",
        "def deleted_handler(): return True",
        "augmented = APIRouter()",
        "augmented += object()",
        "@augmented.get('/augmented')",
        "def augmented_handler(): return True",
        "destructured = APIRouter()",
        "destructured, other = object(), object()",
        "@destructured.get('/destructured')",
        "def destructured_handler(): return True"
      ].join("\n")
    });
    expect(analyzeRepo(root, { readContent: true }).nodes.filter((n) => n.kind === "Endpoint")).toEqual([]);
  });

  it("rejects conditional handlers and does not leak dependencies from conditional duplicates", () => {
    const root = repo({
      "src/handlers.py": [
        "from fastapi import APIRouter, Depends",
        "router = APIRouter()",
        "def dependency(): return True",
        "@router.get('/good')",
        "def good(): return True",
        "if enabled():",
        "    @router.get('/conditional')",
        "    def good(value = Depends(dependency)): return value",
        "if enabled():",
        "    def conditional_only(): return True",
        "router.add_api_route('/bad', conditional_only, methods=['GET'])",
        "def rebound(): return True",
        "rebound = conditional_only",
        "router.add_api_route('/rebound', rebound, methods=['GET'])"
      ].join("\n")
    });
    const fragment = analyzeRepo(root, { readContent: true });
    expect(fragment.nodes.filter((n) => n.kind === "Endpoint").map((n) => n.title)).toEqual(["GET /good"]);
    expect(fragment.edges.some((e) => e.relationship_type === "DEPENDS_ON" || e.properties?.call_via === "fastapi_dependency")).toBe(false);
  });

  it("retains imported and persistence-field destructive sinks but rejects common Python false positives", () => {
    const root = repo({
      "src/services/accounts.py": [
        "import os",
        "import typing",
        "from typing import TYPE_CHECKING",
        "from vendor.orm import Model, BudgetRepository",
        "from ui import Tree",
        "if TYPE_CHECKING:",
        "    from vendor.secret import SecretModel",
        "if typing.TYPE_CHECKING:",
        "    from vendor.secret import OtherModel",
        "",
        "def delete_account(items, local):",
        "    Model.delete('x')",
        "    Tree.delete('x')",
        "    OtherModel.delete('x')",
        "    os.remove('/tmp/x')",
        "    items.remove('x')",
        "    local.replace('x', 'y')",
        "",
        "def delete_budget(client):",
        "    BudgetRepository(client).table.delete('x')",
        "",
        "class AccountService:",
        "    def delete_user(self):",
        "        return self.repository.delete('x')",
        "    def remove_item(self):",
        "        return self.items.delete('x')"
      ].join("\n")
    });
    const graph = toGraph(analyzeRepo(root, { readContent: true }), root);
    const deleteAccount = graph.nodes.find((n) => n.external_id === "sym:src/services/accounts.py#delete_account")!;
    const purgeBudget = graph.nodes.find((n) => n.external_id === "sym:src/services/accounts.py#delete_budget")!;
    const deleteUser = graph.nodes.find((n) => n.external_id === "sym:src/services/accounts.py#AccountService.delete_user")!;
    const removeItem = graph.nodes.find((n) => n.external_id === "sym:src/services/accounts.py#AccountService.remove_item")!;

    expect(deleteAccount.properties.imported_static_callees).toEqual(["Model.delete"]);
    expect(purgeBudget.properties.imported_static_callees).toEqual(["BudgetRepository.table.delete"]);
    expect(deleteUser.properties.external_callees).toEqual(["self.repository.delete"]);
    expect(removeItem.properties.external_callees).toBeUndefined();
    const allRetained = [
      ...((deleteAccount.properties.imported_static_callees as string[] | undefined) ?? []),
      ...((deleteAccount.properties.external_callees as string[] | undefined) ?? [])
    ];
    expect(allRetained).not.toEqual(expect.arrayContaining(["os.remove", "items.remove", "local.replace", "Tree.delete", "SecretModel.delete", "OtherModel.delete"]));

    const sinks = new Map(rankRiskGaps(graph, { repoRoot: root, limit: 100 }).map((r) => [r.id, r.sink_callee]));
    expect(sinks.get(deleteAccount.external_id)).toBe("Model.delete");
    expect(sinks.get(purgeBudget.external_id)).toBe("BudgetRepository.table.delete");
    expect(sinks.get(deleteUser.external_id)).toBe("self.repository.delete");
  });
});
