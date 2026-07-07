import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { opAnalyze } from "../../src/local/operations.js";
import {
  JobRecord,
  JobStatus,
  appendJobLog,
  jobLogPath,
  listJobs,
  newJobId,
  readJobRecord,
  updateJobRecord,
  writeJobRecord
} from "../../src/local/jobs/jobStore.js";
import { runGenerateJob } from "../../src/local/jobs/runner.js";
import { notifyJobDone } from "../../src/local/jobs/notify.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "oplocal-jobs-"));
  dirs.push(d);
  return d;
}
const DEPS = { clock: () => "2026-06-07T00:00:00Z", env: {} as NodeJS.ProcessEnv };

function rec(root: string, id: string, status: JobStatus = "queued"): JobRecord {
  return { id, status, command: "generate", created_at: "2026-06-07T00:00:00Z", cwd: root, args: {}, log_path: jobLogPath(root, id) };
}

describe("jobStore", () => {
  it("newJobId is deterministic with injected clock + rng", () => {
    expect(newJobId(() => 100, () => "abc")).toBe(`job_${(100).toString(36)}_abc`);
  });

  it("write / read / update / list round-trip + log append", () => {
    const root = temp();
    writeJobRecord(root, rec(root, "j1"));
    expect(readJobRecord(root, "j1")?.status).toBe("queued");

    const updated = updateJobRecord(root, "j1", { status: "done" });
    expect(updated?.status).toBe("done");
    expect(readJobRecord(root, "j1")?.status).toBe("done");

    writeJobRecord(root, rec(root, "j2", "running"));
    expect(listJobs(root).map((r) => r.id).sort()).toEqual(["j1", "j2"]);

    appendJobLog(root, "j1", "hello");
    expect(existsSync(jobLogPath(root, "j1"))).toBe(true);
  });

  it("readJobRecord returns null for an unknown id", () => {
    expect(readJobRecord(temp(), "nope")).toBeNull();
  });
});

describe("runGenerateJob", () => {
  it("runs the A/B job to done and records outputs (deterministic)", async () => {
    const root = temp();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
    writeFileSync(join(root, "src", "cart.ts"), "export function total(a){return a;}\n");
    writeFileSync(join(root, "src", "cart.test.ts"), 'import {total} from "./cart";\ntest("t",()=>{expect(total(1)).toBe(1)});\n');
    opAnalyze(root, { source: root }, DEPS);

    await runGenerateJob(root, "jrun", { provider: "deterministic", limit: 1 }, DEPS);

    const r = readJobRecord(root, "jrun");
    expect(r?.status).toBe("done");
    expect(r?.outputs?.tests_path).toBeTruthy();
    expect(existsSync(r!.outputs!.tests_path!)).toBe(true);
  });

  it("single (agent) mode writes a result file with run_hints", async () => {
    const root = temp();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
    writeFileSync(join(root, "requirements.csv"), "behavior_name,acceptance_criteria\nCheckout,Totals are summed\n");
    writeFileSync(join(root, "src", "cart.ts"), "export function total(a){return a;}\n");
    opAnalyze(root, { source: root }, DEPS);

    await runGenerateJob(root, "jsingle", { provider: "deterministic", limit: 1, target_ids: ["sym:src/cart.ts#total"] }, DEPS, "single");

    const r = readJobRecord(root, "jsingle");
    expect(r?.status).toBe("done");
    expect(r?.outputs?.result_path).toBeTruthy();
    const payload = JSON.parse(readFileSync(r!.outputs!.result_path!, "utf8"));
    expect(Array.isArray(payload.generated_tests)).toBe(true);
    expect(Array.isArray(payload.run_hints)).toBe(true);
    expect(Array.isArray(payload.agent_workflow)).toBe(true);
    expect(payload.generated_tests[0].target_symbol_external_id).toBe("sym:src/cart.ts#total");
    expect(payload.run_hints[0].prove_run).toMatchObject({
      tool: "orangepro_prove",
      args: {
        target_symbol: "sym:src/cart.ts#total",
        test_path: payload.run_hints[0].suggested_path,
        replacement: "return null;"
      }
    });
    expect(payload.run_hints[0].record_run?.tool).toBe("orangepro_record_run");
  });

  it("single (agent) mode does not give run hints to draft tests", async () => {
    const root = temp();
    writeFileSync(join(root, "requirements.csv"), "behavior_name,acceptance_criteria\nCheckout,Totals are summed\n");
    opAnalyze(root, { source: root }, DEPS);

    await runGenerateJob(root, "jdraft", { provider: "deterministic", limit: 1 }, DEPS, "single");

    const r = readJobRecord(root, "jdraft");
    expect(r?.status).toBe("done");
    const payload = JSON.parse(readFileSync(r!.outputs!.result_path!, "utf8"));
    expect(payload.generated_tests).toHaveLength(1);
    expect(payload.generated_tests[0].runnable).toBe(false);
    expect(payload.run_hints).toEqual([]);
  });

  it("records failed status when there is no graph to load", async () => {
    const root = temp();
    await runGenerateJob(root, "jfail", { provider: "deterministic" }, DEPS);
    const r = readJobRecord(root, "jfail");
    expect(r?.status).toBe("failed");
    expect(r?.error).toBeTruthy();
  });
});

describe("notifyJobDone", () => {
  it("rings the bell and calls the notifier (injected — no real OS call)", () => {
    let bell = "";
    let notified = "";
    notifyJobDone(rec(temp(), "jn", "done"), {
      write: (s) => (bell += s),
      notifier: (_t, b) => (notified = b),
      platform: "linux"
    });
    expect(bell).toBe(String.fromCharCode(7));
    expect(notified).toMatch(/done/);
  });
});
