// OrangePro's reporter for a Vitest stage of the chain (probe-fault, verify-test, export-tests).
//
// Vitest runs this module in its main process and the tests in other processes (the stage forces
// `--pool forks`), so a test cannot reach what this file holds. The reporter:
//   - reads a key the parent gives only to it, on stdin, once, when it loads (64 hex characters and a
//     newline); the key is in no argument, variable, mount or file;
//   - at the end of the run writes exactly one frame to stdout,
//     `<<OPRO-FRAME:v1:<hmac>:<base64 report>>>`, signed with that key, and nothing anywhere else.
// The report has the shape the Mocha stage's reporter writes: one entry per test, a hook or load
// failure marked as such, and the runner's own totals beside them, counted a second way.
import { createHmac } from "node:crypto";
import { readSync, writeSync } from "node:fs";

function readKey() {
  const buf = Buffer.alloc(65);
  let got = 0;
  try {
    while (got < 65) {
      const n = readSync(0, buf, got, 65 - got, null);
      if (n <= 0) break;
      got += n;
    }
  } catch {
    return null;
  }
  const text = buf.toString("latin1", 0, got);
  return got === 65 && /^[0-9a-f]{64}\n$/.test(text) ? Buffer.from(text.slice(0, 64), "hex") : null;
}

const KEY = readKey();

function plain(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function detailOf(error) {
  const detail = {
    name: typeof error?.name === "string" ? error.name : null,
    constructorName: null,
    message: typeof error?.message === "string" ? error.message : String(error?.message ?? error ?? ""),
    stack: typeof error?.stack === "string" ? error.stack : null
  };
  for (const key of ["actual", "expected", "operator", "code"]) {
    if (error && Object.prototype.hasOwnProperty.call(error, key)) detail[key] = plain(error[key]);
  }
  return detail;
}

function messageOf(error) {
  if (typeof error?.stack === "string" && error.stack.trim()) return error.stack;
  return `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
}

function entry(file, ancestors, title, status, extra) {
  return { ancestorTitles: ancestors, fullName: [...ancestors, title].join(" "), status, title, file, duration: null, failureMessages: [], failureDetails: [], ...extra };
}

function failed(file, ancestors, title, phase, errors) {
  const list = errors.length > 0 ? errors : [{ name: "Error", message: "the runner reported a failure with no error" }];
  return entry(file, ancestors, title, "failed", { failurePhase: phase, failureMessages: list.map(messageOf), failureDetails: list.map(detailOf) });
}

function ancestorsOf(test) {
  const titles = [];
  for (let parent = test.parent; parent && parent.type === "suite"; parent = parent.parent) titles.unshift(parent.name);
  return titles;
}

// The runner's own task tree, walked without the reporting interface: a second count of what ran.
function countTasks(task, totals) {
  const children = Array.isArray(task?.tasks) ? task.tasks : null;
  if (children) {
    if (task.result?.state === "fail" && Array.isArray(task.result.errors) && task.result.errors.length > 0) totals.failures += 1;
    for (const child of children) countTasks(child, totals);
    return;
  }
  const state = task?.result?.state;
  totals.tests += 1;
  if (state === "pass") totals.passes += 1;
  else if (state === "fail") totals.failures += 1;
  else totals.pending += 1;
}

export default class OrangeProChainReporter {
  onTestRunEnd(testModules, unhandledErrors) {
    const files = new Map();
    const bucket = (file) => {
      if (!files.has(file)) files.set(file, { name: file, assertionResults: [] });
      return files.get(file).assertionResults;
    };
    const totals = { tests: 0, passes: 0, failures: 0, pending: 0 };
    for (const module of Array.from(testModules ?? [])) {
      const file = module.moduleId;
      const out = bucket(file);
      // A file that did not load, or whose top-level setup failed.
      const moduleErrors = module.errors();
      if (moduleErrors.length > 0) out.push(failed(file, [], "the test file", "hook", moduleErrors));
      for (const suite of module.children.allSuites()) {
        const errors = suite.errors();
        if (errors.length > 0) out.push(failed(file, ancestorsOf(suite), `${suite.name} (setup or teardown)`, "hook", errors));
      }
      for (const test of module.children.allTests()) {
        const result = test.result();
        const ancestors = ancestorsOf(test);
        const retries = test.diagnostic()?.retryCount ?? 0;
        if (result.state === "passed" && retries > 0) {
          // A test that passed only on a later try did not pass.
          out.push(failed(file, ancestors, test.name, "test", [{ name: "Error", message: `passed only after ${retries} more tries` }]));
        } else if (result.state === "passed") {
          out.push(entry(file, ancestors, test.name, "passed", { duration: test.diagnostic()?.duration ?? null }));
        } else if (result.state === "failed") {
          out.push(failed(file, ancestors, test.name, "test", Array.from(result.errors ?? [])));
        } else {
          out.push(entry(file, ancestors, test.name, "pending", {}));
        }
      }
      countTasks(module.task, totals);
      if (module.task?.result?.state === "fail" && moduleErrors.length > 0 && !Array.isArray(module.task.tasks)) totals.failures += 1;
    }
    // An error outside any test: the run is not a clean account of the tests.
    const stray = Array.from(unhandledErrors ?? []);
    if (stray.length > 0) {
      bucket("").push(failed("", [], "an error outside any test", "hook", stray));
      totals.failures += 1;
    }
    const body = `${JSON.stringify({ testResults: Array.from(files.values()), stats: totals }, null, 2)}\n`;
    if (!KEY) return;
    const payload = Buffer.from(body, "utf8").toString("base64");
    const tag = createHmac("sha256", KEY).update(payload, "latin1").digest("hex");
    const bytes = Buffer.from(`\n<<OPRO-FRAME:v1:${tag}:${payload}>>\n`, "latin1");
    for (let written = 0; written < bytes.length; ) {
      try {
        written += writeSync(1, bytes, written, bytes.length - written);
      } catch (error) {
        if (error?.code !== "EAGAIN") throw error;
      }
    }
  }
}
