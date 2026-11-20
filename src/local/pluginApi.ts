// The add-on interface (types only; this file imports nothing).
//
// An add-on is a separate package the engine uses when it is installed. Everything an
// add-on returns is a proposal: the engine checks it with the same checks it applies to
// a person's input, and only the engine's own runs set an evidence tier or a verdict.

/** Same major version: the add-on is used. A different major: it is not. */
export const PLUGIN_API_VERSION = "1.0.0" as const;

/** The one package name the engine looks for. */
export const ADDON_PACKAGE = "@orangepro/mcp-pro" as const;

export const ADDON_INTERFACES = ["FaultSelector", "OracleProposer", "CheckResolver", "RuntimeLinker", "PlatformClient"] as const;
export type AddonInterfaceName = (typeof ADDON_INTERFACES)[number];

/** Named in run profiles, receipts and reports when an add-on's answer was used. Absent otherwise. */
export interface AddonProvenance {
  name: string;
  version: string;
  api_version: string;
  /** The interfaces whose answers were used, sorted. */
  used: AddonInterfaceName[];
}

// ── FaultSelector ──

export interface FaultSelectorContext {
  /** A record from `opro changed-targets --json`. */
  target_record: unknown;
  /** The folder the target's file path is relative to. */
  source_root: string;
  /** The operator names the engine accepts. */
  operators: readonly string[];
}

export interface FaultProposal {
  /** `<operator>@<byte offset>`, exactly as `--fault` takes it. */
  fault: string;
  /** Why this fault, in plain words. */
  reason: string;
}

export interface FaultSelector {
  /** Ordered, best first. The engine checks the first one as it checks `--fault`. */
  proposeFaults(context: FaultSelectorContext): Promise<FaultProposal[]> | FaultProposal[];
}

// ── OracleProposer ──

export interface OracleProposerContext {
  target_record: unknown;
  source_root: string;
}

export interface OracleProposal {
  /** An `oracle.json` draft. The engine marks it `proposed`, whatever it says. */
  oracle: unknown;
  /** The witness script's text. Its sha256 must be the draft's `witness.sha256`. */
  witness_source: string;
}

export interface OracleProposer {
  proposeOracle(context: OracleProposerContext): Promise<OracleProposal | null> | OracleProposal | null;
}

// ── CheckResolver ──

export interface CheckResolverContext {
  source_root: string;
  /** Workspace path of `graph.json`. */
  graph_path: string;
}

export interface CheckProposal {
  /** A function's id in the graph. */
  symbol_id: string;
  /** An existing test file, relative to the source root. */
  test_file: string;
}

export interface CheckResolver {
  /** Which existing test to try for which function. The engine's own proof run decides the result. */
  proposeChecks(context: CheckResolverContext): Promise<CheckProposal[]> | CheckProposal[];
}

// ── RuntimeLinker ──

export interface RuntimeLinkerContext {
  source_root: string;
  /** The only folder the returned files may be in. */
  workspace_dir: string;
}

export interface RuntimeLinker {
  /** Coverage files the add-on produced, as paths inside `workspace_dir`. Recorded with their source; not counted in API 1.0. */
  coverageFiles(context: RuntimeLinkerContext): Promise<string[]> | string[];
}

// ── PlatformClient ──

export interface PlatformClientContext {
  source_root: string;
  workspace_dir: string;
  /** Workspace-relative paths of the files the run wrote. */
  files: string[];
}

export interface PlatformResult {
  ok: boolean;
  url?: string;
}

export interface PlatformClient {
  /** Called only when the user asks for an upload. */
  publish(context: PlatformClientContext): Promise<PlatformResult> | PlatformResult;
}

// ── Registration ──

export interface PluginApi {
  apiVersion: string;
  registerFaultSelector(selector: FaultSelector): void;
  registerOracleProposer(proposer: OracleProposer): void;
  registerCheckResolver(resolver: CheckResolver): void;
  registerRuntimeLinker(linker: RuntimeLinker): void;
  registerPlatformClient(client: PlatformClient): void;
}

/** What the add-on package's entry module exports. */
export interface PluginModule {
  pluginApiVersion: string;
  register(api: PluginApi): void | Promise<void>;
}
