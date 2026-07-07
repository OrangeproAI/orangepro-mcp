import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts/spikes/dynamic-proof-nest-typeorm-recipe.mjs");

function makeRepo() {
  const tmp = mkdtempSync(path.join(tmpdir(), "opro-nest-typeorm-recipe-"));
  const repo = path.join(tmp, "repo");
  mkdirSync(path.join(repo, "src/tag"), { recursive: true });
  writeFileSync(path.join(repo, "src/tag/tag.entity.ts"), "export class TagEntity { id!: number; tag!: string; }\n");
  writeFileSync(path.join(repo, "src/tag/tag.service.ts"), "export class TagService { async findAll() { return []; } }\n");
  return { tmp, repo };
}

describe("dynamic proof Nest TypeORM recipe helper", () => {
  it("generates a sqljs integration spec and guarded dynamic-proof cases", () => {
    const { tmp, repo } = makeRepo();
    const outConfig = path.join(tmp, "cases.json");

    const stdout = execFileSync(process.execPath, [
      script,
      "--root",
      repo,
      "--repo-name",
      "nestjs-realworld-sqljs",
      "--spec",
      "src/tag/tag.service.dynamic-proof.spec.ts",
      "--service",
      "src/tag/tag.service.ts",
      "--service-class",
      "TagService",
      "--entity",
      "src/tag/tag.entity.ts",
      "--entity-class",
      "TagEntity",
      "--method",
      "findAll",
      "--assert-property",
      "tag",
      "--seed-json",
      "[{\"tag\":\"angularjs\"},{\"tag\":\"reactjs\"}]",
      "--expected-json",
      "[\"angularjs\",\"reactjs\"]",
      "--wrong-json",
      "[]",
      "--equivalent-json",
      "[{\"id\":1,\"tag\":\"angularjs\"},{\"id\":2,\"tag\":\"reactjs\"}]",
      "--jest-config",
      "jest.json",
      "--out-config",
      outConfig
    ], {
      cwd: root,
      encoding: "utf8"
    });

    expect(JSON.parse(stdout)).toEqual({
      spec: "src/tag/tag.service.dynamic-proof.spec.ts",
      outConfig,
      cases: 2
    });
    const spec = readFileSync(path.join(repo, "src/tag/tag.service.dynamic-proof.spec.ts"), "utf8");
    expect(spec).toContain("TypeOrmModule.forRoot");
    expect(spec).toContain("type: \"sqljs\"");
    expect(spec).toContain("TypeOrmModule.forFeature([TagEntity])");
    expect(spec).toContain("await repo.save");
    expect(spec).toContain("await service.findAll()");
    expect(spec).toContain("rows.map(row => row.tag).sort()");
    expect(spec).toContain("from \"./tag.service\"");
    expect(spec).toContain("from \"./tag.entity\"");

    const config = JSON.parse(readFileSync(outConfig, "utf8"));
    expect(config.cases).toHaveLength(2);
    expect(config.cases[0]).toEqual(expect.objectContaining({
      repo: "nestjs-realworld-sqljs",
      test: "src/tag/tag.service.dynamic-proof.spec.ts",
      target: "src/tag/tag.service.ts",
      method: "findAll",
      replacement: "return [];",
      replacementMode: "promise-json",
      runner: "jest",
      jestConfig: "jest.json",
      expected: "proven",
      testEnv: { OPRO_TEST_DATABASE_URL: "sqljs://nestjs-realworld-sqljs" }
    }));
    expect(config.cases[1]).toEqual(expect.objectContaining({
      replacement: "return [{\"id\":1,\"tag\":\"angularjs\"},{\"id\":2,\"tag\":\"reactjs\"}];",
      expected: "associated_survived"
    }));
  });

  it("rejects paths that escape the target repo", () => {
    const { repo } = makeRepo();
    const result = spawnSync(process.execPath, [
      script,
      "--root",
      repo,
      "--repo-name",
      "bad",
      "--spec",
      "../leak.spec.ts",
      "--service",
      "src/tag/tag.service.ts",
      "--service-class",
      "TagService",
      "--entity",
      "src/tag/tag.entity.ts",
      "--entity-class",
      "TagEntity",
      "--method",
      "findAll",
      "--assert-property",
      "tag",
      "--seed-json",
      "[]",
      "--expected-json",
      "[]",
      "--wrong-json",
      "[]",
      "--equivalent-json",
      "[]",
      "--out-config",
      path.join(repo, "cases.json")
    ], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--spec escapes --root");
  });
});
