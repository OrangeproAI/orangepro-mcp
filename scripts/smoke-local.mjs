// Runtime smoke test for the OrangePro Local Proof Kit against a temp fixture.
// Exercises the same operations core that the CLI and MCP server call.
// Usage: node scripts/smoke-local.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  opInit,
  opAnalyze,
  opStatus,
  opScore,
  opDoctor,
  opGaps,
  opGenerate,
  opExplain,
  opExport
} from "../dist/local/operations.js";
import { validatePackJson } from "../dist/local/pack/validate.js";
import { readFileSync } from "node:fs";

const root = mkdtempSync(join(tmpdir(), "op-demo-"));
let failures = 0;
const check = (label, cond) => {
  process.stdout.write(`${cond ? "PASS" : "FAIL"}  ${label}\n`);
  if (!cond) failures++;
};

try {
  mkdirSync(join(root, "src/payments"), { recursive: true });
  mkdirSync(join(root, "tests/payments"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "demo-pay", devDependencies: { vitest: "^3", "@playwright/test": "^1" } }, null, 2)
  );
  writeFileSync(
    join(root, "src/payments/card.ts"),
    `export function validateCard(num: string): boolean { return num.length === 16; }\nexport function saveCard(num: string) { return { id: "c_1", num }; }\n`
  );
  writeFileSync(
    join(root, "tests/payments/card.test.ts"),
    `import { describe, it, expect } from "vitest";\ndescribe("payments card", () => {\n  it("saves a valid card", () => { expect(true).toBe(true); });\n  it("rejects an invalid card number", () => { expect(true).toBe(true); });\n});\n`
  );
  writeFileSync(
    join(root, "payments-template.csv"),
    [
      "behavior_name,description,acceptance_criteria,actor_or_role,priority_or_risk,source_ref,screen_api_service_or_job,known_bugs_or_incidents",
      `"User can save a payment method","Customer adds a card and sees it at checkout","Card is validated; Saved card appears at checkout",buyer,high,PAY-1,"POST /payments","Expired cards were accepted (INC-22)"`,
      `"User can delete a saved card","Customer removes a stored card","Card no longer listed",buyer,medium,PAY-2,"DELETE /payments/:id",`
    ].join("\n")
  );
  writeFileSync(
    join(root, "docs/requirements.md"),
    `# Refund requirement\n\n## Acceptance Criteria\n- Refund returns funds within 5 days\n- Refund is blocked for fraudulent orders\n`
  );

  opInit(root);
  const analyze = opAnalyze(root, {});
  check("analyze produced entities", analyze.entities_count > 0);
  check("analyze produced relationships", analyze.relationships_count > 0);
  check("analyze found >=2 sources (repo + template/docs)", analyze.sources_count >= 2);

  const status = opStatus(root);
  check("status fresh after analyze", status.freshness === "fresh");
  check("status upload disabled", status.privacy.upload_enabled === false);
  check("status snippets not in pack", status.privacy.source_snippets_in_pack === false);

  const score = opScore(root);
  process.stdout.write(`  score=${score.overall} band=${score.band}\n`);
  check("score in range", score.overall >= 0 && score.overall <= 100);
  check("missing_evidence present", Array.isArray(score.missing_evidence));

  const doctor = opDoctor(root);
  check("doctor recommendations", doctor.recommendations.length > 0);

  const gaps = opGaps(root, { limit: 10 });
  check("gaps computed", gaps.total_behaviors > 0);

  const gen = await opGenerate(root, { limit: 2, framework: "playwright", provider: "deterministic" });
  process.stdout.write(`  provider=${gen.model_provider} tests=${gen.generated_tests.length}\n`);
  check("generate produced tests (deterministic offline)", gen.generated_tests.length > 0);
  check("generated test has grounding", gen.generated_tests[0]?.grounding.entity_ids.length > 0);
  check("generate did not write repo files", gen.wrote_repo_files === false);

  if (gen.generated_tests[0]) {
    const explain = opExplain(root, gen.generated_tests[0].id);
    check("explain resolves grounding", explain.grounded_by.length > 0);
  }

  const exp = opExport(root, "evidence.json");
  check("export schema valid", exp.validation.valid === true);
  if (!exp.validation.valid) process.stdout.write("  errors: " + exp.validation.errors.join("; ") + "\n");

  const packJson = readFileSync(exp.pack_path, "utf8");
  const reval = validatePackJson(packJson);
  check("re-validate written pack", reval.valid === true);

  // No-IP-leak smoke: pack must not contain prompt/weight markers.
  const banned = ["prompt_version_text", "system_prompt", "weights", "WEIGHTS", "buildGroundedUserPrompt"];
  check("pack has no leaked internals", !banned.some((b) => packJson.includes(b)));
  // Pack must not contain raw source bodies (function impl) since snippets are off.
  check("pack has no raw source body", !packJson.includes("return num.length === 16"));

  process.stdout.write(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
