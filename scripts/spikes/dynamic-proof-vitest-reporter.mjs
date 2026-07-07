import { writeFileSync } from "node:fs";

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

function collectAssertions(task, ancestors = []) {
  const children = Array.isArray(task?.tasks) ? task.tasks : [];
  if (children.length > 0) {
    return children.flatMap(child => collectAssertions(child, [...ancestors, task.name].filter(Boolean)));
  }
  const errors = Array.isArray(task?.result?.errors) ? task.result.errors : [];
  const state = task?.result?.state;
  return [{
    ancestorTitles: ancestors,
    fullName: [...ancestors, task?.name].filter(Boolean).join(" "),
    status: state === "fail" ? "failed" : state === "pass" ? "passed" : "pending",
    title: task?.name ?? "",
    failureMessages: errors.map(failureMessage),
    failureDetails: errors.map(serializeError)
  }];
}

export default class DynamicProofReporter {
  writeReport(files) {
    const report = {
      testResults: files.map(file => ({
        name: file.filepath ?? file.name ?? file.task?.file?.filepath ?? file.task?.file?.name ?? "",
        assertionResults: collectAssertions(file.task ?? file)
      }))
    };
    const body = `${JSON.stringify(report, null, 2)}\n`;
    if (process.env.OPRO_DYNAMIC_PROOF_REPORT) {
      writeFileSync(process.env.OPRO_DYNAMIC_PROOF_REPORT, body);
      return;
    }
    process.stdout.write(body);
  }

  onFinished(files) {
    this.writeReport(files);
  }

  onTestRunEnd(modules) {
    this.writeReport(Array.from(modules ?? []));
  }
}
