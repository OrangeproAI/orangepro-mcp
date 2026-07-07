/**
 * Executes a background `generate` job IN the detached child. Reuses the same
 * op* functions unchanged; the only extra is streaming progress to the job log
 * and recording status transitions. Directly callable (no spawning) so tests can
 * run it with a tmp root + deterministic provider.
 *
 * Two modes:
 *  - "compare" (default A/B): runs opCompare + writeCompareReport.
 *  - "single" (agent mode): runs opGenerate and writes a result file with the
 *    generated tests + run hints so a polling agent can write & run them.
 */
import { writeFileSync } from "node:fs";
import { GenerateOptions } from "../types.js";
import { ProviderOverride } from "../localConfig.js";
import { OperationDeps, opCompare, opGenerate, writeCompareReport } from "../operations.js";
import { runnableRunHintsFor, AGENT_RUN_WORKFLOW } from "../generate/runHints.js";
import { setProgressReporter } from "../util/progress.js";
import { appendJobLog, jobLogPath, jobResultPath, readJobRecord, updateJobRecord, writeJobRecord } from "./jobStore.js";
import { notifyJobDone } from "./notify.js";

export type JobMode = "compare" | "single";

export async function runGenerateJob(
  root: string,
  id: string,
  opts: GenerateOptions & ProviderOverride,
  deps?: OperationDeps,
  mode: JobMode = "compare"
): Promise<void> {
  const stamp = (): string => (deps ? deps.clock() : new Date().toISOString());
  // The launcher normally pre-creates the queued record; create it if missing so
  // runGenerateJob is self-sufficient (and directly unit-testable).
  if (!readJobRecord(root, id)) {
    writeJobRecord(root, { id, status: "queued", command: "generate", created_at: stamp(), cwd: root, args: {}, log_path: jobLogPath(root, id) });
  }
  updateJobRecord(root, id, { status: "running", started_at: stamp(), pid: process.pid });
  setProgressReporter((m) => appendJobLog(root, id, m));
  try {
    if (mode === "single") {
      appendJobLog(root, id, "Generating tests (single arm — agent mode)…");
      const result = await opGenerate(root, opts, deps);
      const resultPath = jobResultPath(root, id);
      // The durable handoff for an agent: each test's code + suggested path + run command.
      writeFileSync(
        resultPath,
        JSON.stringify(
          {
            model_provider: result.model_provider,
            model_name: result.model_name,
            generated_tests: result.generated_tests,
            run_hints: runnableRunHintsFor(result.generated_tests, root),
            agent_workflow: AGENT_RUN_WORKFLOW,
            missing_evidence: result.missing_evidence,
            warnings: result.warnings
          },
          null,
          2
        ) + "\n",
        "utf8"
      );
      updateJobRecord(root, id, { status: "done", finished_at: stamp(), outputs: { result_path: resultPath } });
      appendJobLog(root, id, `Done — ${result.generated_tests.length} test(s) + run hints: ${resultPath}`);
    } else {
      appendJobLog(root, id, "Generating A/B comparison (prompt-only vs Local KG)…");
      const cmp = await opCompare(root, opts, deps);
      const noTests = cmp.baseline.generated_tests.length === 0 && cmp.grounded.generated_tests.length === 0;
      const outputs = cmp.model_provider !== "none" && !noTests ? writeCompareReport(root, cmp, deps) : undefined;
      updateJobRecord(root, id, {
        status: "done",
        finished_at: stamp(),
        outputs: outputs
          ? {
              tests_path: outputs.local_kg_tests_path,
              report_path: outputs.report_path,
              report_json_path: outputs.report_json_path
            }
          : undefined
      });
      appendJobLog(root, id, outputs ? `Done — Local KG tests: ${outputs.local_kg_tests_path}` : "Done — no tests generated (see report).");
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    updateJobRecord(root, id, { status: "failed", finished_at: stamp(), error });
    appendJobLog(root, id, `Failed: ${error}`);
  } finally {
    setProgressReporter(null);
    const rec = readJobRecord(root, id);
    if (rec) notifyJobDone(rec);
  }
}
