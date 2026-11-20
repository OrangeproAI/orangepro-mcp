// The five places the engine asks the add-on for something. Each returns null (or an
// empty list) when there is no add-on or no usable answer, and the caller then does
// exactly what it does today. Nothing here sets an evidence tier or a verdict.

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { checkFaultEditInput, FAULT_OPERATORS, type FaultEditInput } from "./contracts/faultRecord.js";
import type { SourceLocation } from "./contracts/location.js";
import type { AddonSourceLocation } from "./pluginApi.js";

// The add-on's copy of the location shape and the engine's own are one shape: each is assignable to the other.
const _sameShapeA: (x: SourceLocation) => AddonSourceLocation = (x) => x;
const _sameShapeB: (x: AddonSourceLocation) => SourceLocation = (x) => x;
void _sameShapeA;
void _sameShapeB;
import { recordBytes, recordSha256, sha256Hex, writeFileAtomic } from "./contracts/io.js";
import { checkOracle, withDraftOrigin } from "./contracts/oracle.js";
import type { AddonProvenance, CheckProposal, PlatformResult } from "./pluginApi.js";
import { addonIdentity, addonProvenance, callAddon, markAddonUsed, pluginsFor } from "./plugins.js";
import { loadGraph, workspacePaths } from "./workspace.js";

export const UPLOAD_ENV = "ORANGEPRO_UPLOAD";
export const PROPOSED_ORACLES_DIR = "proposed-oracles";

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const insideRepo = (value: string): boolean => value !== "" && !isAbsolute(value) && !value.split(/[\\/]/).includes("..");

function realInside(parent: string, child: string): boolean {
  try {
    const top = realpathSync(parent);
    const real = realpathSync(child);
    return real.startsWith(top.endsWith(sep) ? top : top + sep);
  } catch {
    return false;
  }
}

/** The folder a target record's file path is relative to: `--source` when given, else the analyzed repository. */
export function sourceRootFor(root: string, source: string | undefined): string {
  if (source) return resolve(root, source);
  try {
    return resolve(loadGraph(workspacePaths(root).graphPath).workspace.root);
  } catch {
    return resolve(root);
  }
}

export interface ProposedFault {
  /** `<operator>@<byte>`; empty when the proposal is an edit. */
  fault: string;
  /** Interface 1.1: the fault as its own edit. */
  edit?: FaultEditInput;
  reason: string;
  /** Interface 1.1: the candidate's own expected behavior and witness text, unchecked. */
  oracle?: unknown;
  witness_source?: string;
  addon: AddonProvenance | undefined;
}

/** How many candidates the add-on's list is cut to before anything is checked. */
export const MAX_CANDIDATES = 20;

/**
 * FaultSelector, whole list: every proposal in the add-on's order, shape-checked only. Each one
 * tried later gets the planner's checks, as `--fault` and `--fault-edit` do. Empty when there is
 * no add-on or no usable answer.
 */
export async function proposeFaults(root: string, sourceRoot: string, targetRecord: unknown): Promise<ProposedFault[]> {
  const selector = (await pluginsFor(root, sourceRoot)).faultSelector;
  if (!selector) return [];
  const proposals = await callAddon(
    "FaultSelector",
    () => selector.proposeFaults({ target_record: targetRecord, source_root: sourceRoot, operators: Object.keys(FAULT_OPERATORS) }),
    (value) => {
      if (!Array.isArray(value)) return null;
      const out: Array<Omit<ProposedFault, "addon">> = [];
      for (const entry of value) {
        if (!isPlain(entry) || typeof entry.reason !== "string") return null;
        const hasFault = typeof entry.fault === "string";
        const hasEdit = entry.edit !== undefined;
        if (hasFault === hasEdit) return null;
        if (entry.fault !== undefined && !hasFault) return null;
        let edit: FaultEditInput | undefined;
        if (hasEdit) {
          const checked = checkFaultEditInput(entry.edit);
          if (!checked.ok) return null;
          edit = checked.input;
        }
        if ((entry.oracle === undefined) !== (entry.witness_source === undefined)) return null;
        if (entry.witness_source !== undefined && typeof entry.witness_source !== "string") return null;
        out.push({
          fault: hasFault ? (entry.fault as string) : "",
          ...(edit ? { edit } : {}),
          reason: entry.reason,
          ...(entry.oracle !== undefined ? { oracle: entry.oracle, witness_source: entry.witness_source as string } : {})
        });
      }
      return out;
    }
  );
  if (!proposals || proposals.length === 0) return [];
  markAddonUsed("FaultSelector");
  const addon = addonProvenance(["FaultSelector"]);
  return proposals.slice(0, MAX_CANDIDATES).map((proposal) => ({ ...proposal, addon }));
}

/**
 * Writes a candidate's own expected behavior as "proposed", whatever it said, for a person to
 * approve. Null when it is not a usable draft for this target.
 */
export function writeProposedOracle(root: string, workspaceDir: string, targetRecord: unknown, candidate: ProposedFault): ProposedOracleFiles | null {
  if (!isPlain(candidate.oracle) || typeof candidate.witness_source !== "string") return null;
  const recordSha = recordSha256(targetRecord);
  const checked = checkOracle(withDraftOrigin({ ...candidate.oracle, approval: { status: "proposed" } }, { name: candidate.addon?.name ?? "add-on", version: candidate.addon?.version ?? "unknown" }));
  if (!checked.ok || checked.oracle.target_record_sha256 !== recordSha) return null;
  if (checked.oracle.witness.sha256 !== sha256Hex(Buffer.from(candidate.witness_source, "utf8"))) return null;
  const dir = join(workspaceDir, PROPOSED_ORACLES_DIR, recordSha.slice(0, 12));
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, "oracle.json"), recordBytes(checked.oracle));
  writeFileAtomic(join(dir, "witness.cjs"), candidate.witness_source);
  return { oracle_path: relative(root, join(dir, "oracle.json")), witness_path: relative(root, join(dir, "witness.cjs")), addon: candidate.addon };
}

/** FaultSelector, first proposal only: asked when the person gave no fault. The engine's own planner still checks the answer. */
export async function proposeFault(root: string, sourceRoot: string, targetRecord: unknown): Promise<ProposedFault | null> {
  return (await proposeFaults(root, sourceRoot, targetRecord))[0] ?? null;
}

export interface ProposedOracleFiles {
  /** Workspace-relative. */
  oracle_path: string;
  witness_path: string;
  addon: AddonProvenance | undefined;
}

/**
 * OracleProposer: asked only when the person gave no expected behavior. The draft is
 * written as "proposed" whatever the add-on said, and the caller stops: nothing runs
 * until a person approves it.
 */
export async function proposeOracle(root: string, sourceRoot: string, workspaceDir: string, targetRecord: unknown): Promise<ProposedOracleFiles | null> {
  const proposer = (await pluginsFor(root, sourceRoot)).oracleProposer;
  if (!proposer) return null;
  const recordSha = recordSha256(targetRecord);
  const proposal = await callAddon(
    "OracleProposer",
    () => proposer.proposeOracle({ target_record: targetRecord, source_root: sourceRoot }),
    (value) => {
      if (value === null || value === undefined) return { none: true as const };
      if (!isPlain(value) || !isPlain(value.oracle) || typeof value.witness_source !== "string") return null;
      const origin = addonIdentity();
      const oracle = withDraftOrigin({ ...value.oracle, approval: { status: "proposed" } }, origin);
      const checked = checkOracle(oracle);
      if (!checked.ok) return null;
      if (checked.oracle.target_record_sha256 !== recordSha) return null;
      if (checked.oracle.witness.sha256 !== sha256Hex(Buffer.from(value.witness_source, "utf8"))) return null;
      return { none: false as const, oracle: checked.oracle, witness: value.witness_source };
    }
  );
  if (!proposal || proposal.none) return null;
  markAddonUsed("OracleProposer");
  const dir = join(workspaceDir, PROPOSED_ORACLES_DIR, recordSha.slice(0, 12));
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, "oracle.json"), recordBytes(proposal.oracle));
  writeFileAtomic(join(dir, "witness.cjs"), proposal.witness);
  return {
    oracle_path: relative(root, join(dir, "oracle.json")),
    witness_path: relative(root, join(dir, "witness.cjs")),
    addon: addonProvenance(["OracleProposer"])
  };
}

export function renderProposedOracle(files: ProposedOracleFiles): string[] {
  return [
    "probe-fault: needs approval. Nothing was run.",
    `  The add-on${files.addon ? ` (${files.addon.name} ${files.addon.version})` : ""} proposed an expected behavior. It is a proposal, not an approval.`,
    `  proposed expected behavior: ${files.oracle_path}`,
    `  proposed witness:           ${files.witness_path}`,
    "  Read both. If they are right, record your approval in the file (approval.status, by, at, where) and pass it with --oracle and --witness."
  ];
}

export interface ProposedChecks {
  proposals: CheckProposal[];
  name: string;
}

/** CheckResolver: which existing test to try for which function. The proof run decides the result. */
export async function proposeChecks(root: string, sourceRoot: string, graphPath: string): Promise<ProposedChecks | null> {
  const resolver = (await pluginsFor(root, sourceRoot)).checkResolver;
  if (!resolver) return null;
  const proposals = await callAddon(
    "CheckResolver",
    () => resolver.proposeChecks({ source_root: sourceRoot, graph_path: graphPath }),
    (value) => {
      if (!Array.isArray(value)) return null;
      for (const entry of value) {
        if (!isPlain(entry) || typeof entry.symbol_id !== "string" || typeof entry.test_file !== "string") return null;
      }
      return value as CheckProposal[];
    }
  );
  if (!proposals) return null;
  // A test outside the repository, or one that is not there, is dropped.
  const kept = proposals.filter((p) => insideRepo(p.test_file) && existsSync(join(sourceRoot, p.test_file)) && realInside(sourceRoot, join(sourceRoot, p.test_file)));
  if (kept.length === 0) return null;
  markAddonUsed("CheckResolver");
  return { proposals: kept, name: addonProvenance(["CheckResolver"])?.name ?? "add-on" };
}

export interface SuppliedCoverage {
  /** Workspace-relative paths of the files accepted. Recorded with their source; not counted. */
  files: string[];
  refused: string[];
}

/** RuntimeLinker: coverage files the add-on produced. Only files inside the workspace folder are accepted. */
export async function suppliedCoverage(root: string, sourceRoot: string, workspaceDir: string): Promise<SuppliedCoverage | null> {
  const linker = (await pluginsFor(root, sourceRoot)).runtimeLinker;
  if (!linker) return null;
  const paths = await callAddon(
    "RuntimeLinker",
    () => linker.coverageFiles({ source_root: sourceRoot, workspace_dir: workspaceDir }),
    (value) => (Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : null)
  );
  if (!paths || paths.length === 0) return null;
  const files: string[] = [];
  const refused: string[] = [];
  for (const path of paths) {
    const abs = resolve(workspaceDir, path);
    if (existsSync(abs) && realInside(workspaceDir, abs)) files.push(relative(workspaceDir, abs));
    else refused.push(path);
  }
  if (files.length > 0) markAddonUsed("RuntimeLinker");
  return { files: files.sort(), refused: refused.sort() };
}

export function uploadAsked(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes|on)$/i.test(String(env[UPLOAD_ENV] ?? ""));
}

/** PlatformClient: called only when the user asked for an upload. A failure is reported, never thrown. */
export async function publishRun(root: string, sourceRoot: string, workspaceDir: string, files: string[], env: NodeJS.ProcessEnv): Promise<PlatformResult | null> {
  if (!uploadAsked(env)) return null;
  const client = (await pluginsFor(root, sourceRoot)).platformClient;
  if (!client) return null;
  const result = await callAddon(
    "PlatformClient",
    () => client.publish({ source_root: sourceRoot, workspace_dir: workspaceDir, files }),
    (value) => {
      if (!isPlain(value) || typeof value.ok !== "boolean") return null;
      if (value.url !== undefined && typeof value.url !== "string") return null;
      return { ok: value.ok, ...(typeof value.url === "string" ? { url: value.url } : {}) } as PlatformResult;
    }
  );
  if (result) markAddonUsed("PlatformClient");
  return result;
}
