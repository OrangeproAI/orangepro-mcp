// The claim behind keeping the classifier's name: a result without the `verdict_rules` marker is exactly what
// the rules before them gave. The runs under __fixtures__/verdict-old-runs are real probe-fault runs, judged and
// stored by the code before the verdict rules (main 75eb947); each is judged again here from its stage files.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { recordBytes } from "../../src/local/contracts/io.js";
import type { Classification, StageName, StageObservation } from "../../src/local/contracts/receipt.js";
import { classificationRecord, classifyFaultRun, type ClassifyInput, type StatementBasis } from "../../src/local/faultProbe.js";

interface StoredRun {
  name: string;
  judge: Omit<ClassifyInput, "stages">;
  statement: StatementBasis;
  stage_files: Record<string, string>;
  classification_json: string;
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "verdict-old-runs");
const runs = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as StoredRun);

/** classification.json for a stored run, judged again by today's code from the stored stage files. */
function judgedAgain(run: StoredRun): { record: Classification; bytes: string } {
  const old = JSON.parse(run.classification_json) as Classification;
  const stages: Partial<Record<StageName, StageObservation>> = {};
  for (const ref of old.stages) stages[ref.stage] = JSON.parse(run.stage_files[ref.path]!) as StageObservation;
  const out = classifyFaultRun({ stages, ...run.judge });
  const record = classificationRecord({
    out,
    stages,
    whole_suite_only: run.judge.whole_suite_only === true,
    baseline_pending: run.judge.baseline_pending ?? 0,
    statement: run.statement,
    run_id: old.run_id,
    fault_record_sha256: old.fault_record_sha256,
    stage_refs: old.stages
  });
  return { record, bytes: recordBytes(record).toString("utf8") };
}

// The stored runs a verdict rule changes, with what each becomes.
const CHANGED: Record<string, Partial<Classification>> = {
  "mixed-assertion-and-crash": { classification: "caught_by_existing", scope: "selected", reason: null },
  "mixed-outside-selection": { classification: "caught_by_existing", scope: "full_suite", reason: "caught_outside_selection" }
};

describe("stored runs judged again: without the verdict_rules marker, the result is byte for byte the old one", () => {
  it("there are stored runs of every kind", () => {
    expect(runs.length).toBeGreaterThanOrEqual(16);
    const classes = new Set(runs.map((run) => (JSON.parse(run.classification_json) as Classification).classification));
    expect([...classes].sort()).toEqual(["blocked", "caught_by_existing", "inconclusive", "survived_unverified"]);
  });

  it.each(runs.map((run) => [run.name, run] as const))("%s", (_name, run) => {
    const { record, bytes } = judgedAgain(run);
    // The claim itself, whatever the run: no marker means the same bytes.
    if (record.verdict_rules === undefined) expect(bytes).toBe(run.classification_json);
    else expect(bytes).not.toBe(run.classification_json);
    // The name of the definition of "at an assertion" never moves.
    expect(record.classifier_version).toBe("orangepro.fault_classifier.v2");
    expect(record.classifier_version).toBe((JSON.parse(run.classification_json) as Classification).classifier_version);
  });

  it("only the runs a rule changes carry the marker, and no rule turns a stored result into a miss", () => {
    const marked = runs.filter((run) => judgedAgain(run).record.verdict_rules !== undefined);
    expect(marked.map((run) => run.name).sort()).toEqual(Object.keys(CHANGED).sort());
    for (const run of marked) {
      const old = JSON.parse(run.classification_json) as Classification;
      const { record } = judgedAgain(run);
      expect(record).toMatchObject({ verdict_rules: "orangepro.verdict_rules.v1", ...CHANGED[run.name] });
      expect(record.also_failed_off_assertion?.length).toBeGreaterThan(0);
      // Only ever towards "caught": never a new miss, and never a wider one.
      expect(record.classification).not.toBe("survived_unverified");
      expect(old.classification === "caught_by_existing" && record.classification !== "caught_by_existing").toBe(false);
    }
  });

  it("a stored stage file changed so that a new rule applies carries the marker", () => {
    const run = runs.find((candidate) => candidate.name === "survived-selected")!;
    const changed: StoredRun = JSON.parse(JSON.stringify(run));
    const stage = JSON.parse(changed.stage_files["stages/fault_selected.json"]!) as StageObservation;
    changed.stage_files["stages/fault_selected.json"] = JSON.stringify({ ...stage, process_did_not_exit: true, exit_code: null });
    expect(judgedAgain(changed).record).toMatchObject({ verdict_rules: "orangepro.verdict_rules.v1", classification: "inconclusive", reason: "fault_process_did_not_exit" });
  });
});
