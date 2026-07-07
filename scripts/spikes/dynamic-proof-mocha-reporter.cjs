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

function isHookFailure(test) {
  const type = String(test?.type ?? "");
  const title = String(test?.title ?? "");
  return type === "hook" || /^(?:"?(?:before|after)(?: each| all)?)/i.test(title);
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
        failurePhase: isHookFailure(test) ? "hook" : "test",
        failureMessages: [failureMessage(error)],
        failureDetails: [serializeError(error)]
      });
    });

    runner.once("end", () => {
      const body = `${JSON.stringify({ testResults: Array.from(files.values()) }, null, 2)}\n`;
      if (process.env.OPRO_DYNAMIC_PROOF_REPORT) {
        writeFileSync(process.env.OPRO_DYNAMIC_PROOF_REPORT, body);
        return;
      }
      process.stdout.write(body);
    });
  }
}

module.exports = DynamicProofMochaReporter;
