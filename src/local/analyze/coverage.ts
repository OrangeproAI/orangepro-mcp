import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { GraphNode, RuntimeCoverageArtifactMeta, RuntimeCoverageMeta } from "../graph/ontology.js";
import { FileRecord } from "../util/walk.js";

type RuntimeCoverageFormat = RuntimeCoverageArtifactMeta["format"];

interface CoveredRange {
  file: string;
  start_line: number;
  end_line: number;
  artifact: string;
  format: RuntimeCoverageFormat;
}

interface ParseResult {
  ranges: CoveredRange[];
  skipped?: { path: string; format: RuntimeCoverageFormat | "unknown"; reason: string };
}

interface ArtifactCandidate {
  path: string;
  format: RuntimeCoverageFormat;
}

const GO_COVERAGE_CANDIDATES = new Set([
  "coverage.out",
  "cover.out",
  "coverprofile.out",
  "go.coverprofile",
  ".orangepro/coverage/go.coverprofile",
  "coverage/coverage.out",
  "coverage/go.coverprofile"
]);

const RUNTIME_COVERAGE_CANDIDATES = new Set([
  ...GO_COVERAGE_CANDIDATES,
  "coverage/lcov.info",
  "lcov.info",
  "coverage.xml",
  "target/site/jacoco/jacoco.xml",
  "build/reports/jacoco/test/jacocoTestReport.xml"
]);

const COVERAGE_SCAN_SKIP_DIRS = new Set([".git", ".orangepro", "node_modules", "vendor", "dist", "build", "target"]);

function coverageFormatForPath(rel: string): RuntimeCoverageFormat | null {
  const normalized = rel.replace(/\\/g, "/");
  const base = path.posix.basename(normalized).toLowerCase();
  if (GO_COVERAGE_CANDIDATES.has(normalized) || /(^|\/)(coverage|cover)(profile)?\.(out|cov)$/i.test(normalized) || /\.coverprofile$/i.test(base)) {
    return "go-coverprofile";
  }
  if (base === "lcov.info" || base.endsWith("-lcov.info") || base.endsWith(".lcov.info")) return "lcov";
  if (base === "coverage.xml" || base.endsWith(".coverage.xml")) return "coverage-py";
  if (base === "jacoco.xml" || normalized.endsWith("/jacocoTestReport.xml")) return "jacoco";
  return null;
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

function symbolLanguage(n: GraphNode): string {
  const file = typeof n.properties.file === "string" ? n.properties.file : n.external_id;
  if (file.includes(".go#") || file.endsWith(".go")) return "go";
  if (/\.(ts|tsx|js|jsx)(#|$)/.test(file)) return "tsjs";
  if (/\.py(#|$)/.test(file)) return "python";
  if (/\.java(#|$)/.test(file)) return "java";
  return "other";
}

function artifactCandidates(root: string, files: FileRecord[]): ArtifactCandidate[] {
  const out = new Map<string, ArtifactCandidate>();
  const add = (candidate: ArtifactCandidate): void => {
    if (!existsSync(path.join(root, candidate.path))) return;
    out.set(candidate.path, candidate);
  };
  for (const f of files) {
    const format = coverageFormatForPath(f.relPath);
    if (format) add({ path: f.relPath, format });
  }
  for (const rel of RUNTIME_COVERAGE_CANDIDATES) {
    const format = coverageFormatForPath(rel);
    if (format && existsSync(path.join(root, rel))) add({ path: rel, format });
  }
  for (const candidate of discoverNestedCoverageArtifacts(root)) add(candidate);
  try {
    for (const entry of readdirSync(path.join(root, ".orangepro/coverage"), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const rel = `.orangepro/coverage/${entry.name}`;
      const format = coverageFormatForPath(rel);
      if (format) add({ path: rel, format });
    }
  } catch {
    /* no generated coverage dir */
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function discoverNestedCoverageArtifacts(root: string): ArtifactCandidate[] {
  const out: ArtifactCandidate[] = [];
  const addLcov = (rel: string): void => {
    if (existsSync(path.join(root, rel))) out.push({ path: rel, format: "lcov" });
  };
  const visit = (dirRel: string): void => {
    let entries;
    try {
      entries = readdirSync(path.join(root, dirRel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (COVERAGE_SCAN_SKIP_DIRS.has(entry.name)) continue;
      const childRel = dirRel ? path.posix.join(dirRel, entry.name) : entry.name;
      if (entry.name.toLowerCase() === "coverage") {
        addLcov(path.posix.join(childRel, "lcov.info"));
        continue;
      }
      visit(childRel);
    }
  };
  visit("");
  return out;
}

function goModuleForDir(dir: string, goModulesByDir: Map<string, string>): { dir: string; module: string } | null {
  for (;;) {
    const module = goModulesByDir.get(dir);
    if (module) return { dir, module };
    if (!dir) return null;
    dir = path.posix.dirname(dir);
    if (dir === ".") dir = "";
  }
}

function relDir(rel: string): string {
  const dir = path.posix.dirname(rel);
  return dir === "." ? "" : dir;
}

function coverageArtifactBaseDir(rel: string): string {
  const dir = relDir(rel.replace(/\\/g, "/"));
  return path.posix.basename(dir).toLowerCase() === "coverage" ? relDir(dir) : dir;
}

function sameModuleOwner(fileRel: string, artifactRel: string, goModulesByDir: Map<string, string>): boolean {
  if (goModulesByDir.size <= 1) return true;
  const artifactOwner = goModuleForDir(relDir(artifactRel), goModulesByDir);
  const fileOwner = goModuleForDir(relDir(fileRel), goModulesByDir);
  return Boolean(artifactOwner && fileOwner && artifactOwner.dir === fileOwner.dir && artifactOwner.module === fileOwner.module);
}

function directGoCoverageMatch(candidate: string, artifactRel: string, goModulesByDir: Map<string, string>, codeFiles: Set<string>): string | null {
  if (candidate.startsWith("../") || !codeFiles.has(candidate)) return null;
  return sameModuleOwner(candidate, artifactRel, goModulesByDir) ? candidate : null;
}

function normalizeGoCoverageFile(rawFile: string, root: string, artifactRel: string, goModulesByDir: Map<string, string>, codeFiles: Set<string>): string | null {
  let raw = rawFile.replace(/\\/g, "/");
  if (path.isAbsolute(raw)) {
    const rel = path.relative(root, raw).replace(/\\/g, "/");
    const direct = directGoCoverageMatch(rel, artifactRel, goModulesByDir, codeFiles);
    if (direct) return direct;
  }
  raw = raw.replace(/^\.\//, "");
  const directMatches = new Set<string>();
  for (const candidate of [raw, relDir(artifactRel) ? path.posix.normalize(path.posix.join(relDir(artifactRel), raw)) : raw]) {
    const direct = directGoCoverageMatch(candidate, artifactRel, goModulesByDir, codeFiles);
    if (direct) directMatches.add(direct);
  }
  if (directMatches.size === 1) return [...directMatches][0];
  const moduleMatches = new Set<string>();
  const modules = [...goModulesByDir.entries()].sort((a, b) => b[1].length - a[1].length || b[0].length - a[0].length);
  for (const [dir, moduleName] of modules) {
    if (!moduleName || !raw.startsWith(`${moduleName}/`)) continue;
    const moduleRel = raw.slice(moduleName.length + 1);
    const rel = path.posix.normalize(dir ? path.posix.join(dir, moduleRel) : moduleRel);
    if (rel.startsWith("../") || (dir && rel !== dir && !rel.startsWith(`${dir}/`))) continue;
    if (!codeFiles.has(rel)) continue;
    if (goModuleForDir(path.posix.dirname(rel), goModulesByDir)?.module !== moduleName) continue;
    moduleMatches.add(rel);
  }
  return moduleMatches.size === 1 ? [...moduleMatches][0] : null;
}

function parseGoCoverprofile(root: string, rel: string, goModulesByDir: Map<string, string>, codeFiles: Set<string>): ParseResult {
  const abs = path.join(root, rel);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return { ranges: [] };
  }
  if (!stat.isFile()) return { ranges: [] };
  if (stat.size > 20_000_000) {
    return { ranges: [], skipped: { path: rel, format: "go-coverprofile", reason: "coverage artifact exceeds 20MB size cap" } };
  }
  let content = "";
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    return { ranges: [] };
  }
  const lines = content.split(/\r?\n/);
  if (!/^mode:\s+(set|count|atomic)\s*$/.test(lines[0] ?? "")) return { ranges: [] };
  const ranges: CoveredRange[] = [];
  let positiveRanges = 0;
  for (const line of lines.slice(1)) {
    const m = line.match(/^(.+):(\d+)\.\d+,(\d+)\.\d+\s+\d+\s+(\d+)$/);
    if (!m || Number(m[4]) <= 0) continue;
    positiveRanges++;
    const file = normalizeGoCoverageFile(m[1], root, rel, goModulesByDir, codeFiles);
    if (!file) continue;
    ranges.push({
      file,
      start_line: Number(m[2]),
      end_line: Number(m[3]),
      artifact: rel,
      format: "go-coverprofile"
    });
  }
  return {
    ranges,
    ...(positiveRanges > 0 && ranges.length === 0
      ? {
          skipped: {
            path: rel,
            format: "go-coverprofile" as const,
            reason: "coverage artifact had positive ranges, but none matched scanned Go files"
          }
        }
      : {})
  };
}

function languageForFormat(format: RuntimeCoverageFormat): "go" | "tsjs" | "python" | "java" {
  if (format === "go-coverprofile") return "go";
  if (format === "lcov") return "tsjs";
  if (format === "coverage-py") return "python";
  return "java";
}

function normalizeCoverageFile(rawFile: string, root: string, artifactRel: string, codeFiles: Set<string>, allowedExt: RegExp): string | null {
  let raw = xmlDecode(rawFile.trim()).replace(/\\/g, "/");
  if (!raw || (raw.includes("://") && !raw.startsWith("file://"))) return null;
  if (raw.startsWith("file://")) raw = raw.slice("file://".length);
  const allowedFiles = [...codeFiles].filter((f) => allowedExt.test(f));
  const direct = (candidate: string): string | null => {
    const rel = candidate.replace(/\\/g, "/").replace(/^\.\//, "");
    if (rel.startsWith("../") || path.posix.isAbsolute(rel)) return null;
    return codeFiles.has(rel) && allowedExt.test(rel) ? rel : null;
  };

  if (path.isAbsolute(raw)) {
    const rel = path.relative(root, raw).replace(/\\/g, "/");
    return direct(rel);
  }

  const candidateSet = new Set<string>([raw]);
  const artifactDir = relDir(artifactRel);
  if (artifactDir) candidateSet.add(path.posix.normalize(path.posix.join(artifactDir, raw)));
  const artifactBaseDir = coverageArtifactBaseDir(artifactRel);
  if (artifactBaseDir) candidateSet.add(path.posix.normalize(path.posix.join(artifactBaseDir, raw)));
  for (const candidate of candidateSet) {
    const match = direct(candidate);
    if (match) return match;
  }

  const suffix = raw.replace(/^\.\//, "");
  if (!suffix.includes("/")) return null;
  const matches = allowedFiles.filter((f) => f === suffix || f.endsWith(`/${suffix}`));
  return matches.length === 1 ? matches[0] : null;
}

function readCoverageText(root: string, rel: string, format: RuntimeCoverageFormat): { content: string; skipped?: ParseResult["skipped"] } | null {
  const abs = path.join(root, rel);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > 20_000_000) {
    return { content: "", skipped: { path: rel, format, reason: "coverage artifact exceeds 20MB size cap" } };
  }
  try {
    return { content: readFileSync(abs, "utf8") };
  } catch {
    return null;
  }
}

function parseLcov(root: string, rel: string, codeFiles: Set<string>): ParseResult {
  const read = readCoverageText(root, rel, "lcov");
  if (!read) return { ranges: [] };
  if (read.skipped) return { ranges: [], skipped: read.skipped };
  const ranges: CoveredRange[] = [];
  let currentFile: string | null = null;
  let positiveRanges = 0;
  for (const line of read.content.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const rawFile = line.slice(3).trim();
      currentFile = rawFile ? normalizeCoverageFile(rawFile, root, rel, codeFiles, /\.(ts|tsx|js|jsx)$/i) : null;
      continue;
    }
    const m = line.match(/^DA:(\d+),(\d+)/);
    if (!m || Number(m[2]) <= 0) continue;
    positiveRanges++;
    if (!currentFile) continue;
    const lineNo = Number(m[1]);
    ranges.push({ file: currentFile, start_line: lineNo, end_line: lineNo, artifact: rel, format: "lcov" });
  }
  return {
    ranges,
    ...(positiveRanges > 0 && ranges.length === 0
      ? { skipped: { path: rel, format: "lcov" as const, reason: "coverage artifact had positive ranges, but none matched scanned TypeScript/JavaScript files" } }
      : {})
  };
}

function xmlAttr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`));
  return m ? xmlDecode(m[1]) : undefined;
}

function xmlDecode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseXmlSources(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/<source>([\s\S]*?)<\/source>/g)) {
    const value = xmlDecode(m[1].trim());
    if (value) out.push(value);
  }
  return out;
}

function parseCoveragePyXml(root: string, rel: string, codeFiles: Set<string>): ParseResult {
  const read = readCoverageText(root, rel, "coverage-py");
  if (!read) return { ranges: [] };
  if (read.skipped) return { ranges: [], skipped: read.skipped };
  const ranges: CoveredRange[] = [];
  const sources = parseXmlSources(read.content);
  let positiveRanges = 0;
  for (const m of read.content.matchAll(/<class\b([^>]*)>([\s\S]*?)<\/class>/g)) {
    const filename = xmlAttr(m[1], "filename");
    if (!filename) continue;
    const fileCandidates = [filename, ...sources.map((source) => path.isAbsolute(source) ? path.join(source, filename) : path.posix.join(source.replace(/\\/g, "/"), filename))];
    let file: string | null = null;
    for (const candidate of fileCandidates) {
      file = normalizeCoverageFile(candidate, root, rel, codeFiles, /\.py$/i);
      if (file) break;
    }
    for (const line of m[2].matchAll(/<line\b([^>]*)\/?>/g)) {
      const number = Number(xmlAttr(line[1], "number"));
      const hits = Number(xmlAttr(line[1], "hits") ?? "0");
      if (!Number.isFinite(number) || hits <= 0) continue;
      positiveRanges++;
      if (!file) continue;
      ranges.push({ file, start_line: number, end_line: number, artifact: rel, format: "coverage-py" });
    }
  }
  return {
    ranges,
    ...(positiveRanges > 0 && ranges.length === 0
      ? { skipped: { path: rel, format: "coverage-py" as const, reason: "coverage artifact had positive ranges, but none matched scanned Python files" } }
      : {})
  };
}

function parseJacocoXml(root: string, rel: string, codeFiles: Set<string>): ParseResult {
  const read = readCoverageText(root, rel, "jacoco");
  if (!read) return { ranges: [] };
  if (read.skipped) return { ranges: [], skipped: read.skipped };
  const ranges: CoveredRange[] = [];
  let positiveRanges = 0;
  for (const pkg of read.content.matchAll(/<package\b([^>]*)>([\s\S]*?)<\/package>/g)) {
    const packageName = (xmlAttr(pkg[1], "name") ?? "").replace(/\./g, "/");
    for (const sf of pkg[2].matchAll(/<sourcefile\b([^>]*)>([\s\S]*?)<\/sourcefile>/g)) {
      const name = xmlAttr(sf[1], "name");
      if (!name) continue;
      const rawFile = packageName ? `${packageName}/${name}` : name;
      const file = normalizeCoverageFile(rawFile, root, rel, codeFiles, /\.java$/i);
      for (const line of sf[2].matchAll(/<line\b([^>]*)\/?>/g)) {
        const number = Number(xmlAttr(line[1], "nr"));
        const coveredInstructions = Number(xmlAttr(line[1], "ci") ?? "0");
        const coveredBranches = Number(xmlAttr(line[1], "cb") ?? "0");
        if (!Number.isFinite(number) || coveredInstructions + coveredBranches <= 0) continue;
        positiveRanges++;
        if (!file) continue;
        ranges.push({ file, start_line: number, end_line: number, artifact: rel, format: "jacoco" });
      }
    }
  }
  return {
    ranges,
    ...(positiveRanges > 0 && ranges.length === 0
      ? { skipped: { path: rel, format: "jacoco" as const, reason: "coverage artifact had positive ranges, but none matched scanned Java files" } }
      : {})
  };
}

function parseCoverageArtifact(root: string, candidate: ArtifactCandidate, goModulesByDir: Map<string, string>, codeFiles: Set<string>): ParseResult {
  if (candidate.format === "go-coverprofile") return parseGoCoverprofile(root, candidate.path, goModulesByDir, codeFiles);
  if (candidate.format === "lcov") return parseLcov(root, candidate.path, codeFiles);
  if (candidate.format === "coverage-py") return parseCoveragePyXml(root, candidate.path, codeFiles);
  return parseJacocoXml(root, candidate.path, codeFiles);
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export function applyRuntimeCoverage(root: string, files: FileRecord[], nodes: GraphNode[], goModulesByDir: Map<string, string>): RuntimeCoverageMeta | undefined {
  const codeFiles = new Set(
    nodes
      .filter((n) => n.kind === "CodeSymbol" && typeof n.properties.file === "string")
      .map((n) => n.properties.file as string)
  );
  const artifacts = artifactCandidates(root, files);
  if (artifacts.length === 0) return undefined;

  const rangesByFile = new Map<string, CoveredRange[]>();
  const artifactStats = new Map<string, { files: Set<string>; covered_ranges: number; format: RuntimeCoverageFormat }>();
  const skippedArtifacts: NonNullable<RuntimeCoverageMeta["skipped_artifacts"]> = [];
  for (const artifact of artifacts) {
    const { ranges, skipped } = parseCoverageArtifact(root, artifact, goModulesByDir, codeFiles);
    if (skipped) skippedArtifacts.push(skipped);
    if (ranges.length === 0) continue;
    const stat = artifactStats.get(artifact.path) ?? { files: new Set<string>(), covered_ranges: 0, format: artifact.format };
    for (const range of ranges) {
      const list = rangesByFile.get(range.file);
      if (list) list.push(range);
      else rangesByFile.set(range.file, [range]);
      stat.files.add(range.file);
      stat.covered_ranges++;
    }
    artifactStats.set(artifact.path, stat);
  }
  if (artifactStats.size === 0 && skippedArtifacts.length === 0) return undefined;

  const byLanguage: RuntimeCoverageMeta["by_language"] = {};
  const coveredSymbols = new Set<string>();
  let totalEligible = 0;
  let symbolsWithSpans = 0;
  const ingestedLanguages = new Set<string>([...artifactStats.values()].map((s) => languageForFormat(s.format)));

  for (const n of nodes) {
    if (n.kind !== "CodeSymbol" || n.denominator_eligible !== true || n.stale === true) continue;
    const lang = symbolLanguage(n);
    if (!ingestedLanguages.has(lang)) continue;
    totalEligible++;
    const bucket = (byLanguage[lang] ??= { eligible: 0, symbols_with_spans: 0, covered: 0, covered_pct: 0 });
    bucket.eligible++;
    const file = typeof n.properties.file === "string" ? n.properties.file : "";
    const start = typeof n.properties.start_line === "number" ? n.properties.start_line : null;
    const end = typeof n.properties.end_line === "number" ? n.properties.end_line : null;
    if (!file || start == null || end == null) continue;
    symbolsWithSpans++;
    bucket.symbols_with_spans++;
    const ranges = rangesByFile.get(file) ?? [];
    const overlapping = ranges.filter((r) => overlaps(start, end, r.start_line, r.end_line));
    if (overlapping.length === 0) continue;
    const formats = [...new Set(overlapping.map((r) => r.format))].sort();
    coveredSymbols.add(n.external_id);
    bucket.covered++;
    n.properties = {
      ...n.properties,
      runtime_covered: true,
      runtime_coverage_formats: formats
    };
  }

  for (const bucket of Object.values(byLanguage)) bucket.covered_pct = pct(bucket.covered, bucket.eligible);

  return {
    artifacts: [...artifactStats.entries()].map(([path, s]) => ({
      path,
      format: s.format,
      files: s.files.size,
      covered_ranges: s.covered_ranges
    })),
    ...(skippedArtifacts.length > 0 ? { skipped_artifacts: skippedArtifacts } : {}),
    total_eligible_symbols: totalEligible,
    symbols_with_spans: symbolsWithSpans,
    covered_symbols: coveredSymbols.size,
    covered_pct: pct(coveredSymbols.size, totalEligible),
    by_language: byLanguage
  };
}
