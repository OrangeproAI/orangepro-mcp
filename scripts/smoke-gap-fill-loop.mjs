#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "dist/local/cli.js");

if (!existsSync(cli)) {
  console.error("dist/local/cli.js not found. Run `npm run build` first.");
  process.exit(1);
}

function run(command, args, opts = {}) {
  return execFileSync(command, args, { stdio: opts.stdio ?? "pipe", encoding: "utf8", ...opts });
}

function runJson(cwd, args) {
  return JSON.parse(run("node", [cli, ...args, "--json"], { cwd }));
}

function writeFixture(root) {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "opro-gap-loop-ts", version: "1.0.0", type: "module" }, null, 2),
    "utf8"
  );
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(
    join(root, "service.ts"),
    [
      "export class OrderService {",
      "  createOrder(id: string): string {",
      "    return `order-${id}`;",
      "  }",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

function writeProofTest(root) {
  writeFileSync(
    join(root, "service.test.ts"),
    [
      "import { describe, expect, it } from 'vitest';",
      "import { OrderService } from './service';",
      "",
      "describe('OrderService', () => {",
      "  it('creates observable order ids', () => {",
      "    expect(new OrderService().createOrder('42')).toBe('order-42');",
      "  });",
      "});",
      ""
    ].join("\n"),
    "utf8"
  );
}

function rowFor(rtm, id) {
  return rtm.rows.find((row) => row.behavior_id === id);
}

const temp = mkdtempSync(join(tmpdir(), "opro-gap-loop-"));
const source = join(temp, "repo");
const ws = join(temp, "workspace");
mkdirSync(source);
mkdirSync(ws);

try {
  writeFixture(source);

  runJson(ws, ["analyze", source, "--no-graph-html"]);
  const target = "sym:service.ts#OrderService.createOrder";
  const before = rowFor(runJson(ws, ["rtm", "--format", "json"]), target);

  const generated = runJson(ws, [
    "generate",
    "--single",
    "--provider",
    "deterministic",
    "--target",
    target,
    "--limit",
    "1"
  ]);
  const hint = generated.generated_tests[0]?.target_symbol_external_id === target;

  writeProofTest(source);
  const proof = runJson(ws, [
    "prove",
    "--target-symbol",
    target,
    "--source",
    source,
    "--test",
    "service.test.ts",
    "--replacement",
    "return null;",
    "--runner",
    "vitest",
    "--link-node-modules",
    "--run-id",
    "smoke-gap-fill-loop"
  ]);
  const stats = runJson(ws, ["stats"]);
  const after = rowFor(runJson(ws, ["rtm", "--format", "json"]), target);

  const result = {
    target,
    baseline_status: before?.status,
    generated_handoff_for_target: hint,
    proof_status: proof.record.status,
    proof_closed: proof.record.closed,
    final_status: after?.status,
    kept_rate: stats.quality_adjusted_kept_rate
  };
  console.log(JSON.stringify(result, null, 2));
  if (
    result.baseline_status !== "No integration signal" ||
    !result.generated_handoff_for_target ||
    result.proof_status !== "reproven" ||
    result.proof_closed !== true ||
    result.final_status !== "Reproven (this run)" ||
    result.kept_rate !== 100
  ) {
    process.exit(1);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
