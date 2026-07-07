import { CandidateEdge, GraphEdge, GraphNode, Provenance, SourceScope } from "../graph/ontology.js";
import { makeCandidateEdge, makeEdge, makeNode } from "../graph/factories.js";
import { hashString } from "../util/hash.js";
import { slugify } from "../util/ids.js";
import { redactSecrets } from "../util/redact.js";
import { GraphFragment } from "../types.js";

const DETECTOR = "csv_template";

/** Canonical template column keys (normalized: lowercase, non-alphanumeric -> '_'). */
type ColumnKey =
  | "behavior_name"
  | "description"
  | "acceptance_criteria"
  | "actor_or_role"
  | "priority_or_risk"
  | "source_ref"
  | "workflow_steps"
  | "screen_api_service_or_job"
  | "known_edge_cases"
  | "known_bugs_or_incidents"
  | "manual_qa_steps"
  | "existing_test_names_or_links"
  | "related_jira_confluence_testrail_github_ids";

/** Aliases mapping normalized header tokens onto canonical column keys. */
const HEADER_ALIASES: Record<string, ColumnKey> = {
  behavior_name: "behavior_name",
  behavior: "behavior_name",
  behaviour_name: "behavior_name",
  name: "behavior_name",
  description: "description",
  desc: "description",
  acceptance_criteria: "acceptance_criteria",
  acceptance: "acceptance_criteria",
  ac: "acceptance_criteria",
  actor_or_role: "actor_or_role",
  actor: "actor_or_role",
  role: "actor_or_role",
  actors: "actor_or_role",
  priority_or_risk: "priority_or_risk",
  priority: "priority_or_risk",
  risk: "priority_or_risk",
  source_ref: "source_ref",
  source: "source_ref",
  source_reference: "source_ref",
  workflow_steps: "workflow_steps",
  workflow: "workflow_steps",
  steps: "workflow_steps",
  screen_api_service_or_job: "screen_api_service_or_job",
  screen_api_service_job: "screen_api_service_or_job",
  interface: "screen_api_service_or_job",
  known_edge_cases: "known_edge_cases",
  edge_cases: "known_edge_cases",
  known_bugs_or_incidents: "known_bugs_or_incidents",
  known_bugs: "known_bugs_or_incidents",
  bugs: "known_bugs_or_incidents",
  incidents: "known_bugs_or_incidents",
  manual_qa_steps: "manual_qa_steps",
  manual_qa: "manual_qa_steps",
  existing_test_names_or_links: "existing_test_names_or_links",
  existing_tests: "existing_test_names_or_links",
  existing_test_names: "existing_test_names_or_links",
  related_jira_confluence_testrail_github_ids: "related_jira_confluence_testrail_github_ids",
  related_ids: "related_jira_confluence_testrail_github_ids",
  related: "related_jira_confluence_testrail_github_ids"
};

/** Header tokens (any one present) that mark a line as the template header row. */
const HEADER_SIGNAL_TOKENS = new Set<string>(["behavior_name", "behavior", "behaviour_name", "acceptance_criteria"]);

/** Normalize a header cell to a comparable token (case/space/underscore-insensitive). */
function normalizeHeader(cell: string): string {
  return cell
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * True when the given line plausibly is the OrangePro template header row.
 * Used by the .txt routing fallback in the dispatcher.
 */
export function looksLikeTemplateHeader(line: string): boolean {
  const cells = parseCsv(line)[0] ?? [];
  return cells.some((c) => HEADER_SIGNAL_TOKENS.has(normalizeHeader(c)));
}

/**
 * Minimal RFC-4180-ish CSV parser. Handles quoted fields, commas/newlines inside
 * quotes, escaped double-quotes (""), and CRLF. Returns rows of string cells.
 */
function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = content.length;

  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      if (content[i + 1] === "\n") i++;
      pushRow();
      i++;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Flush trailing field/row unless the content ended with a clean newline and no
  // dangling data.
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

/** Drop rows that are entirely empty (no non-whitespace cell). */
function isBlankRow(cells: string[]): boolean {
  return cells.every((c) => c.trim() === "");
}

/** Split a multi-item cell on ';' or newlines; trims and drops empties. */
function splitItems(value: string): string[] {
  return value
    .split(/[;\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Zero-padded requirement index (1 -> "001"). */
function padIndex(n: number): string {
  return String(n).padStart(3, "0");
}

/**
 * Enrich from the OrangePro minimum customer template (CSV).
 *
 * Reviewed template rows are treated as HARD evidence: each data row yields a
 * Requirement node plus hard acceptance-criterion edges, candidate interface
 * edges, and (where present) regression links from incidents. Privacy: only
 * metadata is captured and any free text is run through secret redaction.
 */
export function enrichFromCsv(relPath: string, content: string): GraphFragment {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const candidate_edges: CandidateEdge[] = [];
  const warnings: string[] = [];

  const sourceScopeId = "manual_template:" + slugify(relPath);
  const source: SourceScope = {
    source_scope_id: sourceScopeId,
    source_system: "manual_template",
    source_type: "customer_supplied",
    display_name: relPath,
    content_hash: hashString(content),
    metadata: { filename: relPath }
  };

  const allRows = parseCsv(content).filter((r) => !isBlankRow(r));
  if (allRows.length === 0) {
    warnings.push(`CSV template '${relPath}' has no rows.`);
    return { nodes, edges, candidate_edges, sources: [source], warnings };
  }

  const headerCells = allRows[0];
  // Only treat a CSV as an OrangePro template if it carries a strong signal
  // column. A bare data CSV (e.g. `id,name,qty`) must NOT become requirements.
  const hasTemplateSignal = headerCells.some((c) => HEADER_SIGNAL_TOKENS.has(normalizeHeader(c)));
  if (!hasTemplateSignal) {
    return {
      nodes: [],
      edges: [],
      candidate_edges: [],
      sources: [],
      warnings: [`CSV '${relPath}' is not an OrangePro template (no behavior_name/acceptance_criteria column); skipped.`]
    };
  }

  const columnIndex = new Map<ColumnKey, number>();
  for (let c = 0; c < headerCells.length; c++) {
    const key = HEADER_ALIASES[normalizeHeader(headerCells[c])];
    if (key && !columnIndex.has(key)) columnIndex.set(key, c);
  }
  if (!columnIndex.has("behavior_name")) {
    warnings.push(`CSV template '${relPath}' is missing a recognizable 'behavior_name' column.`);
  }

  const cell = (row: string[], key: ColumnKey): string => {
    const idx = columnIndex.get(key);
    if (idx === undefined) return "";
    const raw = row[idx];
    return raw === undefined ? "" : redactSecrets(raw).trim();
  };

  const dataRows = allRows.slice(1);
  let reqIndex = 0;

  for (let r = 0; r < dataRows.length; r++) {
    const row = dataRows[r];
    const behaviorName = cell(row, "behavior_name");
    if (behaviorName === "") continue;
    reqIndex++;

    const rowNumber = r + 2; // 1-based, accounting for the header row.
    const reqExternalId = "REQ-" + padIndex(reqIndex) + "-" + slugify(behaviorName);

    const description = cell(row, "description");
    const actorsRaw = cell(row, "actor_or_role");
    const actors = splitItems(actorsRaw);
    const priority = cell(row, "priority_or_risk");
    const sourceRef = cell(row, "source_ref");
    const workflowSteps = splitItems(cell(row, "workflow_steps"));
    const screenApi = cell(row, "screen_api_service_or_job");
    const knownEdgeCases = splitItems(cell(row, "known_edge_cases"));
    const knownBugs = splitItems(cell(row, "known_bugs_or_incidents"));
    const manualQaSteps = cell(row, "manual_qa_steps");
    const existingTestNames = splitItems(cell(row, "existing_test_names_or_links"));
    const relatedIds = cell(row, "related_jira_confluence_testrail_github_ids");
    const acceptanceCriteria = splitItems(cell(row, "acceptance_criteria"));

    const rowProvenance: Provenance = {
      source_scope_id: sourceScopeId,
      source_ref: sourceRef || `${relPath}#row=${rowNumber}`,
      detector: DETECTOR
    };

    const properties: Record<string, unknown> = {};
    if (description) properties.description = description;
    if (acceptanceCriteria.length > 0) properties.acceptance_criteria = acceptanceCriteria;
    if (actors.length > 0) properties.actors = actors;
    if (priority) properties.priority = priority;
    if (workflowSteps.length > 0) properties.workflow_steps = workflowSteps;
    if (screenApi) properties.screen_api_service_or_job = screenApi;
    if (knownEdgeCases.length > 0) properties.known_edge_cases = knownEdgeCases;
    if (knownBugs.length > 0) properties.known_bugs = knownBugs;
    if (manualQaSteps) properties.manual_qa_steps = manualQaSteps;
    if (existingTestNames.length > 0) properties.existing_test_names = existingTestNames;
    if (relatedIds) properties.related_ids = relatedIds;

    nodes.push(
      makeNode({
        kind: "Requirement",
        external_id: reqExternalId,
        title: behaviorName,
        properties,
        evidence_strength: "hard",
        review_status: "local_reviewed",
        confidence: 0.95,
        provenance: rowProvenance,
        content_hash: hashString(behaviorName + "|" + description),
        behavior_source: "requirement_template",
        denominator_eligible: true,
        denominator_reason: "Reviewed template row — explicit behavior."
      })
    );

    // Acceptance criteria → hard AcceptanceCriterion nodes + HAS_ACCEPTANCE_CRITERION edges.
    for (let a = 0; a < acceptanceCriteria.length; a++) {
      const acText = acceptanceCriteria[a];
      const acExternalId = "AC-" + slugify(behaviorName) + "-" + padIndex(a + 1);
      nodes.push(
        makeNode({
          kind: "AcceptanceCriterion",
          external_id: acExternalId,
          title: acText,
          properties: { text: acText, behavior: reqExternalId },
          evidence_strength: "hard",
          review_status: "local_reviewed",
          confidence: 0.95,
          provenance: rowProvenance,
          content_hash: hashString(acText)
        })
      );
      edges.push(
        makeEdge({
          from_external_id: reqExternalId,
          to_external_id: acExternalId,
          relationship_type: "HAS_ACCEPTANCE_CRITERION",
          evidence_strength: "hard",
          review_status: "local_reviewed",
          provenance: rowProvenance
        })
      );
    }

    // Interface field → Service/Endpoint node + candidate MAY_REQUIRE_INTERFACE edge.
    if (screenApi) {
      const ifaceSlug = slugify(screenApi);
      const ifaceExternalId = "iface:" + ifaceSlug;
      const isEndpoint = /\/|https?:|\bapi\b|endpoint|route|\bget\b|\bpost\b|\bput\b|\bdelete\b/i.test(screenApi);
      nodes.push(
        makeNode({
          kind: isEndpoint ? "Endpoint" : "Service",
          external_id: ifaceExternalId,
          title: screenApi,
          properties: { name: screenApi, inferred_from: "template_interface_field" },
          evidence_strength: "candidate",
          review_status: "inferred",
          confidence: 0.6,
          provenance: rowProvenance
        })
      );
      candidate_edges.push(
        makeCandidateEdge({
          from_external_id: reqExternalId,
          to_external_id: ifaceExternalId,
          relationship_type: "MAY_REQUIRE_INTERFACE",
          evidence_strength: "candidate",
          reason: "from template interface field",
          confidence: 0.6,
          provenance: rowProvenance
        })
      );
    }

    // Known bugs/incidents → Incident node + hard REGRESSION_OF edge (Incident → behavior).
    for (let b = 0; b < knownBugs.length; b++) {
      const bugText = knownBugs[b];
      const incidentExternalId = "incident:" + slugify(behaviorName) + "-" + padIndex(b + 1);
      nodes.push(
        makeNode({
          kind: "Incident",
          external_id: incidentExternalId,
          title: bugText,
          properties: { summary: bugText, behavior: reqExternalId },
          evidence_strength: "hard",
          review_status: "local_reviewed",
          confidence: 0.95,
          provenance: rowProvenance,
          content_hash: hashString(bugText)
        })
      );
      edges.push(
        makeEdge({
          from_external_id: incidentExternalId,
          to_external_id: reqExternalId,
          relationship_type: "REGRESSION_OF",
          evidence_strength: "hard",
          review_status: "local_reviewed",
          provenance: rowProvenance
        })
      );
    }
  }

  if (reqIndex === 0) {
    warnings.push(`CSV template '${relPath}' produced no behaviors (no populated 'behavior_name' rows).`);
  }

  return { nodes, edges, candidate_edges, sources: [source], warnings };
}
