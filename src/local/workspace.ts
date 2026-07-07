import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LocalGraph, LOCAL_GRAPH_SCHEMA_VERSION } from "./graph/ontology.js";
import { defaultPrivacySettings, LocalProofConfig } from "./localConfig.js";

export const WORKSPACE_DIR = ".orangepro";
export const GRAPH_FILE = "graph.json";
export const CONFIG_FILE = "config.json";

export interface WorkspacePaths {
  root: string;
  dir: string;
  graphPath: string;
  configPath: string;
}

export function workspacePaths(root: string): WorkspacePaths {
  const absRoot = resolve(root);
  const dir = join(absRoot, WORKSPACE_DIR);
  return {
    root: absRoot,
    dir,
    graphPath: join(dir, GRAPH_FILE),
    configPath: join(dir, CONFIG_FILE)
  };
}

export function workspaceInitialized(root: string): boolean {
  return existsSync(workspacePaths(root).configPath);
}

export function graphExists(root: string): boolean {
  return existsSync(workspacePaths(root).graphPath);
}

const ORANGEPROIGNORE_TEMPLATE = `# .orangeproignore — paths the OrangePro local proof kit should never read.
# Same spirit as .gitignore. Secrets and large assets are excluded by default.
*.env
*.pem
*.key
secrets/
*evidence-pack.json
*evidence-pack.md

# Product-denominator defaults: example/demo apps are useful references, but
# they usually should not count as product behavior coverage.
examples/
example/
demos/
demo/
samples/
sample/
docs/examples/
docs/demo/
docs/demos/
`;

export function initWorkspace(root: string, now: string): { paths: WorkspacePaths; config: LocalProofConfig } {
  const paths = workspacePaths(root);
  mkdirSync(paths.dir, { recursive: true });

  const config: LocalProofConfig = {
    workspace_name: deriveWorkspaceName(paths.root),
    created_at: now,
    local_only: true,
    privacy: defaultPrivacySettings()
  };

  if (!existsSync(paths.configPath)) {
    writeJson(paths.configPath, config);
  }

  const ignorePath = join(paths.root, ".orangeproignore");
  if (!existsSync(ignorePath)) {
    writeFileSync(ignorePath, ORANGEPROIGNORE_TEMPLATE, "utf8");
  }

  return { paths, config: loadConfig(paths) };
}

export function loadConfig(paths: WorkspacePaths): LocalProofConfig {
  if (!existsSync(paths.configPath)) {
    return {
      workspace_name: deriveWorkspaceName(paths.root),
      created_at: "",
      local_only: true,
      privacy: defaultPrivacySettings()
    };
  }
  return JSON.parse(readFileSync(paths.configPath, "utf8")) as LocalProofConfig;
}

export function saveConfig(paths: WorkspacePaths, config: LocalProofConfig): void {
  writeJson(paths.configPath, config);
}

export function loadGraph(graphPath: string): LocalGraph {
  if (!existsSync(graphPath)) {
    throw new Error(`No graph found at ${graphPath}. Run \`opro analyze .\` first.`);
  }
  const graph = JSON.parse(readFileSync(graphPath, "utf8")) as LocalGraph;
  if (graph.schema_version !== LOCAL_GRAPH_SCHEMA_VERSION) {
    // Force-rebuild on any schema mismatch: the graph is fully derived from the
    // repo, so rebuilding loses nothing and silently consuming an old schema
    // (e.g. v0 without denominator fields) would corrupt coverage math.
    throw new Error(
      `Graph schema mismatch: found ${graph.schema_version ?? "unknown"}, expected ${LOCAL_GRAPH_SCHEMA_VERSION}. ` +
        "Run `opro analyze .` to rebuild — no data loss (the graph is derived from your repo)."
    );
  }
  return graph;
}

export function saveGraph(graphPath: string, graph: LocalGraph): void {
  writeJson(graphPath, graph);
}

export function deriveWorkspaceName(root: string): string {
  return resolve(root).split(/[\\/]/).filter(Boolean).pop() || "workspace";
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}
