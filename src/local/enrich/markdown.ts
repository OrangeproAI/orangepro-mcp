import { GraphEdge, GraphNode, Provenance, SourceScope } from "../graph/ontology.js";
import { makeEdge, makeNode } from "../graph/factories.js";
import { hashString } from "../util/hash.js";
import { slugify } from "../util/ids.js";
import { redactSecrets } from "../util/redact.js";
import { GraphFragment } from "../types.js";

const DETECTOR = "markdown_docs";
const MAX_REQUIREMENTS = 60;

/**
 * Repo-governance and template markdown must never mint Requirement nodes.
 * Hint words like "should"/"must" are ubiquitous in CONTRIBUTING files and
 * PR/issue templates — on Hono, ".github/PULL_REQUEST_TEMPLATE.md" produced
 * REQ-md-the-author-should-do-the-following-if-applicable and surfaced as the
 * report's top suggested next action. Product docs (README, docs/) still count.
 */
const GOVERNANCE_MD_RE =
  /(^|\/)\.github\/|(^|\/)(CONTRIBUTING|CODE_OF_CONDUCT|PULL_REQUEST_TEMPLATE|ISSUE_TEMPLATE|SECURITY|SUPPORT|CHANGELOG|LICENSE|GOVERNANCE|MAINTAINERS|CODEOWNERS|AUTHORS)[^\/]*$|(^|\/)\.changeset\//i;

/** Words that suggest a heading describes a requirement/feature behavior. */
const REQUIREMENT_HINTS: ReadonlyArray<string> = [
  "requirement",
  "feature",
  "behavior",
  "behaviour",
  "user story",
  "story",
  "use case",
  "scenario",
  "capability",
  "flow",
  "rule",
  "must",
  "should",
  "shall",
  "support",
  "allow"
];

/** True when a heading's text looks like a requirement/feature anchor. */
function looksLikeRequirement(text: string): boolean {
  const lower = text.toLowerCase();
  return REQUIREMENT_HINTS.some((hint) => lower.includes(hint));
}

/** True when a heading marks an acceptance-criteria section. */
function isAcceptanceHeading(text: string): boolean {
  return text.toLowerCase().includes("acceptance criteria");
}

interface HeadingMatch {
  level: number;
  text: string;
}

/** Parse an ATX heading line (#, ##, ###). Returns null for non-headings. */
function parseHeading(line: string): HeadingMatch | null {
  const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  if (!m) return null;
  return { level: m[1].length, text: m[2].trim() };
}

/** Parse a bullet/list-item line, returning its trimmed text or null. */
function parseBullet(line: string): string | null {
  const m = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/.exec(line);
  return m ? m[1].trim() : null;
}

/**
 * Deterministic Markdown enrichment.
 *
 * Headings that look like requirements become candidate Requirement nodes
 * (inferred from doc structure). Bullets under an "acceptance criteria" section
 * become AcceptanceCriterion nodes linked to the nearest preceding requirement.
 * Bounded to ~60 requirements; all captured text is secret-redacted.
 */
export function enrichFromMarkdown(relPath: string, content: string): GraphFragment {
  if (GOVERNANCE_MD_RE.test(relPath)) {
    return { nodes: [], edges: [], candidate_edges: [], sources: [], warnings: [] };
  }
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const warnings: string[] = [];

  const sourceScopeId = "markdown_docs:" + slugify(relPath);
  const source: SourceScope = {
    source_scope_id: sourceScopeId,
    source_system: "markdown_docs",
    source_type: "customer_supplied",
    display_name: relPath,
    content_hash: hashString(content),
    metadata: { filename: relPath }
  };

  const prov = (line: number): Provenance => ({
    source_scope_id: sourceScopeId,
    source_ref: `${relPath}#L${line}`,
    detector: DETECTOR
  });

  const lines = content.split(/\r\n|\r|\n/);
  const reqSlugs = new Set<string>();
  let reqCount = 0;
  let inFence = false;

  // Tracks the most recent requirement (for AC linkage) and AC-section state.
  let currentReqExternalId: string | null = null;
  let lastHeading: { text: string; level: number; line: number } | null = null;
  let inAcceptanceSection = false;
  let acHeadingLevel = 0;
  const acCounterByReq = new Map<string, number>();
  let capped = false;

  /** Create a candidate Requirement node from a heading, returning its external id. */
  const createRequirement = (text: string, level: number, line: number): string | null => {
    if (capped) return null;
    if (reqCount >= MAX_REQUIREMENTS) {
      capped = true;
      warnings.push(`Markdown '${relPath}' requirement cap (${MAX_REQUIREMENTS}) reached; later headings omitted.`);
      return null;
    }
    const clean = redactSecrets(text);
    let slug = slugify(clean);
    let suffix = 1;
    while (reqSlugs.has(slug)) {
      suffix++;
      slug = slugify(clean) + "-" + suffix;
    }
    reqSlugs.add(slug);
    const reqExternalId = "REQ-md-" + slug;
    nodes.push(
      makeNode({
        kind: "Requirement",
        external_id: reqExternalId,
        title: clean,
        properties: { description: clean, heading_level: level, inferred_from: "markdown_heading" },
        evidence_strength: "candidate",
        review_status: "inferred",
        confidence: 0.55,
        provenance: prov(line),
        content_hash: hashString(clean),
        behavior_source: "markdown_requirement",
        denominator_eligible: true,
        denominator_reason: "Markdown requirement heading — explicit behavior."
      })
    );
    reqCount++;
    return reqExternalId;
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNumber = i + 1;

    // Respect fenced code blocks: never treat their contents as headings/bullets.
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = parseHeading(rawLine);
    if (heading) {
      if (isAcceptanceHeading(heading.text)) {
        inAcceptanceSection = true;
        acHeadingLevel = heading.level;
        // An explicit Acceptance Criteria section is strong evidence its preceding
        // heading is a requirement — promote it even if it lacked a hint word.
        if (!currentReqExternalId && lastHeading) {
          currentReqExternalId = createRequirement(lastHeading.text, lastHeading.level, lastHeading.line);
        }
        continue;
      }
      // A heading at or above the AC section's level closes that section.
      if (inAcceptanceSection && heading.level <= acHeadingLevel) {
        inAcceptanceSection = false;
      }

      lastHeading = { text: heading.text, level: heading.level, line: lineNumber };
      if (looksLikeRequirement(heading.text)) {
        const id = createRequirement(heading.text, heading.level, lineNumber);
        if (id) currentReqExternalId = id;
      } else {
        // New non-requirement heading starts a fresh section; forget the prior req
        // so stray bullets don't attach across unrelated sections.
        currentReqExternalId = null;
      }
      continue;
    }

    // Bullets inside an acceptance-criteria section → AcceptanceCriterion nodes.
    if (inAcceptanceSection && currentReqExternalId) {
      const bullet = parseBullet(rawLine);
      if (bullet) {
        const acText = redactSecrets(bullet);
        const reqId = currentReqExternalId;
        const next = (acCounterByReq.get(reqId) ?? 0) + 1;
        acCounterByReq.set(reqId, next);
        const acExternalId = "AC-md-" + slugify(reqId.replace(/^REQ-md-/, "")) + "-" + String(next).padStart(3, "0");
        nodes.push(
          makeNode({
            kind: "AcceptanceCriterion",
            external_id: acExternalId,
            title: acText,
            properties: { text: acText, behavior: reqId, inferred_from: "markdown_acceptance_section" },
            evidence_strength: "reviewed",
            review_status: "local_reviewed",
            confidence: 0.6,
            provenance: prov(lineNumber),
            content_hash: hashString(acText)
          })
        );
        edges.push(
          makeEdge({
            from_external_id: reqId,
            to_external_id: acExternalId,
            relationship_type: "HAS_ACCEPTANCE_CRITERION",
            evidence_strength: "reviewed",
            review_status: "local_reviewed",
            provenance: prov(lineNumber)
          })
        );
      }
    }
  }

  if (reqCount === 0) {
    warnings.push(`Markdown '${relPath}' yielded no requirement headings.`);
  }

  return { nodes, edges, candidate_edges: [], sources: [source], warnings };
}
