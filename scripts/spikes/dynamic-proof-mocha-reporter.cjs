const { writeFileSync } = require("node:fs");

function safeValue(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function serializeError(error) {
  const detail = {
    name: error?.name ?? null,
    constructorName: error?.constructor?.name ?? null,
    message: error?.message ?? null,
    stack: error?.stack ?? null
  };
  for (const key of ["actual", "expected", "operator", "showDiff", "ok", "diff", "generatedMessage", "code"]) {
    if (error && key in error) {
      detail[key] = safeValue(error[key]);
    }
  }
  return detail;
}

function failureMessage(error) {
  if (typeof error?.stack === "string" && error.stack.trim()) {
    return error.stack;
  }
  const name = error?.name ?? "Error";
  const message = error?.message ?? String(error);
  return `${name}: ${message}`;
}

function ancestorTitles(test) {
  const titles = [];
  let parent = test?.parent;
  while (parent) {
    if (parent.title) {
      titles.unshift(parent.title);
    }
    parent = parent.parent;
  }
  return titles;
}

// Mocha marks a hook with type "hook". The title is consulted only when no type is given at all: a test
// whose title happens to start with "before" or "after" is a test.
function isHookFailure(test) {
  const type = String(test?.type ?? "");
  if (type) {
    return type === "hook";
  }
  return /^"(?:before|after)(?: each| all)?" hook/i.test(String(test?.title ?? ""));
}

class DynamicProofMochaReporter {
  constructor(runner) {
    const files = new Map();

    function bucket(test) {
      const file = test?.file ?? "";
      if (!files.has(file)) {
        files.set(file, { name: file, assertionResults: [] });
      }
      return files.get(file);
    }

    runner.on("pass", test => {
      bucket(test).assertionResults.push({
        ancestorTitles: ancestorTitles(test),
        fullName: typeof test?.fullTitle === "function" ? test.fullTitle() : test?.title ?? "",
        status: "passed",
        title: test?.title ?? "",
        file: test?.file ?? null,
        duration: typeof test?.duration === "number" ? test.duration : null,
        failureMessages: [],
        failureDetails: []
      });
    });

    // A skipped or pending test did not run. It is listed so that a run of nothing is visible as such.
    runner.on("pending", test => {
      bucket(test).assertionResults.push({
        ancestorTitles: ancestorTitles(test),
        fullName: typeof test?.fullTitle === "function" ? test.fullTitle() : test?.title ?? "",
        status: "pending",
        title: test?.title ?? "",
        file: test?.file ?? null,
        duration: null,
        failureMessages: [],
        failureDetails: []
      });
    });

    runner.on("fail", (test, error) => {
      bucket(test).assertionResults.push({
        ancestorTitles: ancestorTitles(test),
        fullName: typeof test?.fullTitle === "function" ? test.fullTitle() : test?.title ?? "",
        status: "failed",
        title: test?.title ?? "",
        file: test?.file ?? null,
        duration: typeof test?.duration === "number" ? test.duration : null,
        failurePhase: isHookFailure(test) ? "hook" : "test",
        failureMessages: [failureMessage(error)],
        failureDetails: [serializeError(error)]
      });
    });

    runner.once("end", () => {
      const stats = runner.stats ?? {};
      const totals = {
        tests: stats.tests ?? null,
        passes: stats.passes ?? null,
        failures: stats.failures ?? null,
        pending: stats.pending ?? null
      };
      const body = `${JSON.stringify({ testResults: Array.from(files.values()), stats: totals }, null, 2)}\n`;
      if (process.env.OPRO_DYNAMIC_PROOF_REPORT) {
        writeFileSync(process.env.OPRO_DYNAMIC_PROOF_REPORT, body);
        return;
      }
      process.stdout.write(body);
    });
  }
}

module.exports = DynamicProofMochaReporter;
