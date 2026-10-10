import { describe, expect, it } from "vitest";
import { csvCell, testsCsv, testsCsvRows, TESTS_CSV_COLUMNS, TESTS_CSV_IMPORT } from "../../src/local/viz/testsExport.js";
import type { WorkItem } from "../../src/local/viz/worklist.js";

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: "sym:service/history/task.go#Task.Execute",
  rank: 3,
  title: "Task.Execute",
  file: "service/history/task.go",
  line: 42,
  area: "service/history",
  score: 82,
  evidence: "unconfirmed",
  verb: "check",
  reason: "Read service/history/task_test.go first: a test there may cover it, but no call was traced.",
  readFirst: "service/history/task_test.go",
  deletes: { via: "e.engine.DeleteExecution", store: "Engine" },
  churn: 140,
  churnAvailable: true,
  callers: 0,
  scheduled: false,
  facts: ["Deletes data through e.engine.DeleteExecution (Engine), within two calls.", "140 changed lines in the last 180 days."],
  prove: "opro prove-loop --target-symbol 'sym:service/history/task.go#Task.Execute' --test 'service/history/task_test.go'",
  slots: [
    {
      state: "plan",
      id: "local-gen-1-t1",
      title: "Skip delete on the active cluster",
      type: "Edge case",
      plan: { preconditions: ["Given an active cluster"], steps: ["When Execute runs"], testData: "ns=\"a\", wf=\"b\"", expected: ["Then nothing is deleted", "A skip metric is recorded"] },
      reason: "The generated code did not pass the compile check.",
      addTo: "service/history/task_test.go"
    },
    { state: "not_drafted", title: "Not drafted", reason: "The model provider refused the request (no credits or rate limit).", addTo: "service/history/task_test.go" }
  ],
  ...over
});

const meta = { repository: "temporalio/temporal", commit: "baa033892586df799bb48ceb03d947ac87c35a13", toolVersion: "0.2.58", generatedAt: "2026-10-09T03:00:00.000Z" };

describe("tests.csv", () => {
  it("guards spreadsheet formulas and quotes what needs quoting", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-rm")).toBe("'-rm");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("a, b")).toBe("\"a, b\"");
    expect(csvCell("line1\nline2")).toBe("\"line1\nline2\"");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(12.5)).toBe("12.5");
  });

  it("writes one row per slot with the import fields first", () => {
    const rows = testsCsvRows([item()], meta);
    expect(rows).toHaveLength(2);
    const byCol = (row: string[]) => Object.fromEntries(TESTS_CSV_COLUMNS.map((c, i) => [c, row[i]]));
    const plan = byCol(rows[0]);
    expect(plan).toMatchObject({
      ID: "local-gen-1-t1",
      Title: "Skip delete on the active cluster",
      Section: "service > history",
      Folder: "service/history",
      Priority: "High",
      "Test type": "Edge case",
      Preconditions: "1. Given an active cluster",
      Steps: "1. When Execute runs",
      "Test data": "ns=\"a\", wf=\"b\"",
      "Steps with data": "1. When Execute runs\n\nTest data: ns=\"a\", wf=\"b\"",
      "Expected result": "1. Then nothing is deleted\n2. A skip metric is recorded",
      References: "Task.Execute · service/history/task.go:42 · baa033892586",
      "What to do": "Check: Read service/history/task_test.go first: a test there may cover it, but no call was traced.",
      "Evidence today": "Unconfirmed",
      Status: "Plan only",
      "Add to file": "service/history/task_test.go",
      Code: "",
      "Priority rank": "3",
      Commit: "baa033892586"
    });
    const empty = byCol(rows[1]);
    expect(empty).toMatchObject({ ID: "sym:service/history/task.go#Task.Execute#2", Title: "Test for Task.Execute (not drafted)", Status: "Not drafted", Code: "" });
    expect(empty["Status reason"]).toContain("no credits");
  });

  it("starts with a byte order mark, uses CRLF, and skips rows without slots", () => {
    const text = testsCsv([item(), item({ rank: 30, slots: undefined, id: "sym:x" })], meta);
    expect(text.startsWith("﻿ID,Title,Section,Folder,Priority,")).toBe(true);
    expect(text.endsWith("\r\n")).toBe(true);
    const records = text.slice(1).split("\r\n").filter(Boolean);
    expect(records).toHaveLength(3);
    expect(testsCsvRows([item({ rank: 6 })], meta)[0][TESTS_CSV_COLUMNS.indexOf("Priority")]).toBe("Medium");
  });
});

describe("import guide", () => {
  it("maps only columns the file has, and each tool field once", () => {
    for (const guide of TESTS_CSV_IMPORT) {
      for (const [column] of guide.fields) expect(TESTS_CSV_COLUMNS).toContain(column);
      const targets = guide.fields.map(([, field]) => field);
      expect(new Set(targets).size).toBe(targets.length);
    }
    expect(TESTS_CSV_IMPORT.map((g) => g.tool)).toEqual(["TestRail", "Jira Xray", "Zephyr Scale"]);
  });
});
