import { readFileSync } from "node:fs";
import { ResolvedImport } from "./resolver.js";
import { hashString } from "../util/hash.js";

/**
 * Phase 5.4.3 — persistent module-RESOLUTION cache for `ts.resolveModuleName`.
 *
 * `ts.resolveModuleName` walks the filesystem, so its answer can change with NO
 * change to the importer, tsconfig, or package.json — e.g. a NEW file shadows an
 * older extension (`./foo.js` -> `./foo.ts` once `foo.ts` is added), or the target
 * is moved/deleted. A naive (importer, specifier, tsconfig) key would silently
 * serve a stale resolution -> a wrong COVERS edge.
 *
 * The invalidation story is a GLOBAL GATE: the whole cache is trusted only while
 * the filesystem SHAPE and resolution config are unchanged. The gate =
 * RESOLVER_VERSION + the sorted file-path set + the content of every JSON config
 * (and lockfile). Any of:
 *   - a file added / removed / renamed (path set changes)   -> new-file shadow, target moved/deleted
 *   - a tsconfig/jsconfig paths/baseUrl edit                 -> path-alias change
 *   - an EXTENDED base config edit (tsconfig extends ./base.json) -> conservatively covered
 *   - a package.json exports / lockfile edit                 -> package-export change
 * busts the ENTIRE cache. We hash ALL walked `.json` (plus lockfiles), not only the
 * tsconfig/package files, because a tsconfig can `extends` an arbitrarily-named JSON
 * file whose edit changes resolution (Codex 5.4.3) — conservative over-busting is
 * the safe failure mode. Within a stable gate, resolution is path-level, so a
 * content-only edit to a non-JSON source keeps its hits.
 *
 * TRUST BOUNDARY (deliberately narrow — see Codex 5.4.3 round-4, consistent with the
 * parse cache): this file is TRUSTED LOCAL WORKSPACE STATE, the same trust level as
 * `.orangepro/graph.json` (read back and trusted wholesale). The GATE handles real
 * staleness (FS shape / config), and shape validation handles corruption — but we do
 * NOT claim tamper-resistance. A "membership" check (target is in the walked set) was
 * tried and removed: it only catches foreign/deleted targets the gate already busts on,
 * and cannot prove a same-gate entry resolves to the RIGHT target — i.e. it was theater.
 */

// Bump when resolveImport's resolution behavior changes.
export const RESOLVER_VERSION = 1;

// Files whose content can change module resolution: ALL JSON configs (tsconfig +
// transitive `extends` bases, jsconfig, package.json, *.json referenced by config)
// plus the non-JSON lockfiles. Conservative by design.
const CONFIG_RE = /(\.json$)|((^|\/)(yarn\.lock|pnpm-lock\.yaml)$)/i;

/** The gate hash: resolver version + filesystem shape + resolution-config content. */
export function computeResolverGate(filePaths: string[]): string {
  const sorted = [...filePaths].sort();
  const configDigest = sorted
    .filter((p) => CONFIG_RE.test(p.replace(/\\/g, "/")))
    .map((p) => {
      try {
        return `${p}:${hashString(readFileSync(p, "utf8"))}`;
      } catch {
        return `${p}:?`;
      }
    });
  return hashString(`v${RESOLVER_VERSION}\n${sorted.join("\n")}\n${configDigest.join("\n")}`);
}

interface ResolverCacheData {
  gate: string;
  entries: Record<string, ResolvedImport>;
}

/** Strict shape validation — the persisted file is untrusted input. */
function validResolvedImport(v: unknown): ResolvedImport | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.resolved !== "boolean" || typeof o.isExternal !== "boolean") return null;
  if (o.resolvedFileName !== null && typeof o.resolvedFileName !== "string") return null;
  // A "resolved" entry must name a target; an unresolved one must not.
  if (o.resolved !== (typeof o.resolvedFileName === "string")) return null;
  return o as unknown as ResolvedImport;
}

export class ResolverCache {
  private entries: Map<string, ResolvedImport>;
  private gate: string;
  hits = 0;
  misses = 0;

  constructor(data?: ResolverCacheData | null) {
    this.gate = data?.gate ?? "";
    this.entries = new Map();
    // Persisted entries are untrusted FOR SHAPE: drop anything off-shape (miss + recompute).
    if (data?.entries && typeof data.entries === "object") {
      for (const [k, raw] of Object.entries(data.entries)) {
        const valid = validResolvedImport(raw);
        if (valid) this.entries.set(k, valid);
      }
    }
  }

  /** Validate against the current run's gate; a mismatch discards ALL entries so no stale
   *  resolution can survive a structural or config change. Call once before resolving. */
  useGate(currentGate: string): void {
    if (this.gate !== currentGate) {
      this.entries = new Map();
      this.gate = currentGate;
    }
  }

  /** Resolution is determined by the containing DIRECTORY (nearest tsconfig + relative base)
   *  plus the specifier — files in the same dir share a result for the same specifier. Within a
   *  stable gate the entry is trusted (the gate already busts on any FS-shape/config change that
   *  could alter resolution); shape was validated on load. */
  resolve(containingDir: string, specifier: string, compute: () => ResolvedImport): ResolvedImport {
    const key = `${containingDir} ${specifier}`;
    const hit = this.entries.get(key);
    if (hit) {
      this.hits++;
      return hit;
    }
    this.misses++;
    const value = compute();
    this.entries.set(key, value);
    return value;
  }

  hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : Math.round((this.hits / total) * 1000) / 10;
  }

  toData(): ResolverCacheData {
    return { gate: this.gate, entries: Object.fromEntries(this.entries) };
  }
}
