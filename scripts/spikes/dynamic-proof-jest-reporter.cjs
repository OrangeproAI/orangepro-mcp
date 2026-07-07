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
  for (const key of ["actual", "expected", "operator", "showDiff", "ok", "diff"]) {
    if (Object.prototype.hasOwnProperty.call(error ?? {}, key)) {
      detail[key] = safeValue(error[key]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(error ?? {}, "matcherResult")) {
    detail.matcherResult = safeValue(error.matcherResult);
  }
  return detail;
}

function normalizeAssertion(assertion) {
  const details = Array.isArray(assertion.failureDetails)
    ? assertion.failureDetails.map(serializeError)
    : [];
  return {
    ancestorTitles: assertion.ancestorTitles ?? [],
    fullName: assertion.fullName ?? assertion.title ?? "",
    status: assertion.status ?? "pending",
    title: assertion.title ?? "",
    failureMessages: Array.isArray(assertion.failureMessages) ? assertion.failureMessages : [],
    failureDetails: details
  };
}

class DynamicProofJestReporter {
  onRunComplete(_, results) {
    const report = {
      testResults: (results.testResults ?? []).map(file => ({
        name: file.testFilePath ?? file.name ?? "",
        assertionResults: (file.testResults ?? file.assertionResults ?? []).map(normalizeAssertion)
      }))
    };
    const body = `${JSON.stringify(report, null, 2)}\n`;
    if (process.env.OPRO_DYNAMIC_PROOF_REPORT) {
      writeFileSync(process.env.OPRO_DYNAMIC_PROOF_REPORT, body);
      return;
    }
    process.stdout.write(body);
  }
}

module.exports = DynamicProofJestReporter;
