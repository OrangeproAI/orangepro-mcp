import { EVIDENCE_LABEL, VERB_LABEL, type TestSlot, type WorkItem } from "./worklist.js";

/**
 * Every drafted test, one row per slot, as a spreadsheet file (R14 §4). Opens in
 * Excel and Google Sheets, and imports into TestRail, Jira Xray and Zephyr Scale:
 * the first columns carry the fields those tools map (see TESTS_CSV_IMPORT); the
 * rest keep OrangePro's context so a row is useful on its own.
 */
export const TESTS_CSV_FILE = "tests.csv";

export const TESTS_CSV_COLUMNS = [
  "ID",
  "Title",
  "Section",
  "Folder",
  "Priority",
  "Test type",
  "Preconditions",
  "Steps",
  "Test data",
  "Steps with data",
  "Expected result",
  "References",
  "What to do",
  "Why it matters",
  "Evidence today",
  "Status",
  "Status reason",
  "Add to file",
  "Code",
  "Prove command",
  "Priority rank",
  "Priority score",
  "Function",
  "Source file",
  "Line",
  "Repository",
  "Commit",
  "OrangePro version",
  "Generated at"
] as const;

export interface TestsCsvMeta {
  repository: string;
  commit: string | null;
  toolVersion: string;
  generatedAt: string;
}

const STATUS_LABEL: Record<TestSlot["state"], string> = { ready: "Ready", plan: "Plan only", not_drafted: "Not drafted" };

/**
 * How the columns import, per tool, from each tool's CSV importer documentation:
 * TestRail "Import test cases from CSV" (Test Case (Text) template, sections nested
 * with " > "), Xray Test Case Importer (one row per test, one manual step) and
 * Zephyr Scale "Import test cases from CSV" (folders nested with "/", no test-data
 * field). Shown in the detailed report and the README; the importer's preview is
 * the final check.
 */
export interface ImportGuide {
  tool: string;
  setup: string;
  fields: ReadonlyArray<readonly [column: (typeof TESTS_CSV_COLUMNS)[number], field: string]>;
  notes: string;
}

export const TESTS_CSV_IMPORT: readonly ImportGuide[] = [
  {
    tool: "TestRail",
    setup: "Test Cases → Import → Import from CSV, encoding UTF-8, template \"Test Case (Text)\", one row per test case.",
    fields: [
      ["Title", "Title"],
      ["Section", "Sections Hierarchy"],
      ["Priority", "Priority"],
      ["Test type", "Type"],
      ["Preconditions", "Preconditions"],
      ["Steps with data", "Steps"],
      ["Expected result", "Expected Result"],
      ["References", "References"]
    ],
    notes: "Map Test type values to your case types in the wizard's value step."
  },
  {
    tool: "Jira Xray",
    setup: "Xray Test Case Importer → CSV, encoding UTF-8, delimiter comma.",
    fields: [
      ["ID", "Test Case Identifier"],
      ["Title", "Summary"],
      ["Folder", "Test Repository Path"],
      ["Priority", "Priority"],
      ["Test type", "Labels"],
      ["References", "Description"],
      ["Steps", "Manual Test Step: Action"],
      ["Test data", "Manual Test Step: Data"],
      ["Expected result", "Manual Test Step: Expected Result"]
    ],
    notes: "Each test imports as one manual step. Xray keeps preconditions as separate issues, so Preconditions is left out, or added to Description."
  },
  {
    tool: "Zephyr Scale",
    setup: "Tests → Import → CSV, encoding UTF-8, delimiter comma. Leave Key empty.",
    fields: [
      ["Title", "Name"],
      ["Folder", "Folder"],
      ["Priority", "Priority"],
      ["Test type", "Labels"],
      ["Preconditions", "Precondition"],
      ["References", "Objective"],
      ["Steps with data", "Test Script (Steps) - Step"],
      ["Expected result", "Test Script (Steps) - Expected Result"]
    ],
    notes: "Zephyr Scale has no test-data field, so use Steps with data. Its default priorities are High, Normal and Low: map Medium to Normal."
  }
];

/**
 * One CSV field. A value a spreadsheet would run as a formula (leading =, +, -, @,
 * tab or carriage return) is prefixed with an apostrophe, so opening the file
 * never executes anything. Fields with a comma, quote or line break are quoted.
 */
export function csvCell(value: string | number | undefined | null): string {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function numbered(lines: readonly string[] | undefined): string {
  return (lines ?? []).map((line, i) => `${i + 1}. ${line}`).join("\n");
}

export function testsCsvRows(items: readonly WorkItem[], meta: TestsCsvMeta): string[][] {
  const rows: string[][] = [];
  const commit = meta.commit ? meta.commit.slice(0, 12) : "";
  for (const item of items) {
    if (!item.slots) continue;
    item.slots.forEach((slot, n) => {
      const plan = slot.plan;
      const title = slot.state === "not_drafted" ? `Test for ${item.title} (not drafted)` : slot.title;
      const ref = `${item.title} · ${item.file}${item.line ? `:${item.line}` : ""}${commit ? ` · ${commit}` : ""}`;
      const steps = numbered(plan?.steps);
      const data = plan?.testData ?? "";
      rows.push([
        slot.id ?? `${item.id}#${n + 1}`,
        title,
        item.area.split("/").join(" > "),
        item.area,
        // Names every tool ships with: the five highest are High, the rest Medium.
        item.rank <= 5 ? "High" : "Medium",
        slot.type ?? "",
        numbered(plan?.preconditions),
        steps,
        data,
        data ? (steps ? `${steps}\n\nTest data: ${data}` : `Test data: ${data}`) : steps,
        numbered(plan?.expected),
        ref,
        `${VERB_LABEL[item.verb]}: ${item.reason}`,
        item.facts.join(" "),
        EVIDENCE_LABEL[item.evidence],
        STATUS_LABEL[slot.state],
        slot.reason ?? "",
        slot.addTo ?? "",
        slot.state === "not_drafted" ? "" : slot.code ?? "",
        item.prove,
        String(item.rank),
        String(item.score),
        item.title,
        item.file,
        item.line !== undefined ? String(item.line) : "",
        meta.repository,
        commit,
        meta.toolVersion,
        meta.generatedAt
      ]);
    });
  }
  return rows;
}

/** The whole file: UTF-8 byte order mark (so Excel reads accents), header, CRLF rows. */
export function testsCsv(items: readonly WorkItem[], meta: TestsCsvMeta): string {
  const lines = [TESTS_CSV_COLUMNS.map((c) => csvCell(c)).join(",")];
  for (const row of testsCsvRows(items, meta)) lines.push(row.map((c) => csvCell(c)).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
