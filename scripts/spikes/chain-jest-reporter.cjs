// OrangePro's reporter for a Jest stage of the chain (probe-fault, verify-test, export-tests).
//
// Jest runs this module in its main process. The stage forces Jest to run every test file in a worker
// process (even a single file), so a test cannot reach what this file holds. The reporter:
//   - reads a key the parent gives only to it, on stdin, once, when it loads (64 hex characters and a
//     newline); the key is in no argument, variable, mount or file;
//   - at the end of the run writes exactly one frame to stdout,
//     `<<OPRO-FRAME:v1:<hmac>:<base64 report>>>`, signed with that key, and nothing anywhere else.
// The report has the shape the Mocha stage's reporter writes. Jest hands a failure over as text (the
// error's name, message and stack in one string), so the name is read from its first line.
const { createHmac } = require("node:crypto");
const { readSync, writeSync } = require("node:fs");

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

function detailOf(text) {
  const first = String(text).split("\n")[0] ?? "";
  const named = /^([A-Za-z_$][\w$]*)(?: \[[^\]]*\])?: ?(.*)$/.exec(first);
  return { name: named ? named[1] : "Error", constructorName: null, message: named ? named[2] : first, stack: String(text) };
}

function entry(file, ancestors, title, status, extra) {
  return { ancestorTitles: ancestors, fullName: [...ancestors, title].join(" "), status, title, file, duration: null, failureMessages: [], failureDetails: [], ...extra };
}

function failed(file, ancestors, title, phase, messages) {
  const list = messages.length > 0 ? messages : ["Error: the runner reported a failure with no error"];
  return entry(file, ancestors, title, "failed", { failurePhase: phase, failureMessages: list, failureDetails: list.map(detailOf) });
}

class OrangeProChainReporter {
  onRunComplete(_contexts, results) {
    const files = [];
    let extraFailures = 0;
    for (const file of Array.isArray(results?.testResults) ? results.testResults : []) {
      const name = file.testFilePath;
      const out = [];
      // A file that did not load or whose setup failed outside any test.
      if (file.testExecError) {
        out.push(failed(name, [], "the test file", "hook", [String(file.testExecError.stack ?? file.testExecError.message ?? file.failureMessage ?? "Error: the test file did not run")]));
        extraFailures += 1;
      }
      for (const test of Array.isArray(file.testResults) ? file.testResults : []) {
        const ancestors = Array.isArray(test.ancestorTitles) ? test.ancestorTitles : [];
        const tries = typeof test.invocations === "number" ? test.invocations : 1;
        if (test.status === "passed" && tries > 1) {
          out.push(failed(name, ancestors, test.title, "test", [`Error: passed only after ${tries - 1} more tries`]));
        } else if (test.status === "passed") {
          out.push(entry(name, ancestors, test.title, "passed", { duration: typeof test.duration === "number" ? test.duration : null }));
        } else if (test.status === "failed") {
          out.push(failed(name, ancestors, test.title, "test", Array.isArray(test.failureMessages) ? test.failureMessages.map(String) : []));
        } else {
          out.push(entry(name, ancestors, test.title, "pending", {}));
        }
      }
      files.push({ name, assertionResults: out });
    }
    // Jest's own totals, beside the entries above. A test that passed only on a later try is counted
    // as passed by Jest and as failed above, so the two then disagree and the stage is not a clean account.
    const totals = {
      tests: results?.numTotalTests ?? null,
      passes: results?.numPassedTests ?? null,
      failures: (results?.numFailedTests ?? 0) + extraFailures,
      pending: (results?.numPendingTests ?? 0) + (results?.numTodoTests ?? 0)
    };
    const body = `${JSON.stringify({ testResults: files, stats: totals }, null, 2)}\n`;
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

module.exports = OrangeProChainReporter;
