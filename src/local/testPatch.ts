// V3: the delivered test-only patch (`orangepro-tests.patch`) read and applied in memory, with no
// git and no file write. Only the shape export-tests writes is accepted: one file, lines added only,
// every context line checked against the file's bytes. Anything else is refused, never guessed.

export interface TestPatch {
  /** Repository-relative path of the one file the patch changes. */
  file: string;
  /** True when the patch creates the file (`--- /dev/null`). */
  creates: boolean;
  hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] }>;
  added: number;
}

export class TestPatchError extends Error {}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse a one-file, adds-only unified diff; throws TestPatchError for anything else. */
export function parseTestPatch(text: string): TestPatch {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let i = 0;
  const header = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[i] ?? "");
  if (!header || header[1] !== header[2]) throw new TestPatchError("the patch does not start with one `diff --git a/<file> b/<file>` line.");
  const file = header[1];
  if (file.startsWith("/") || file.split("/").some((part) => part === ".." || part === "." || part === "")) throw new TestPatchError(`the patch names a path outside the repository: ${file}.`);
  i += 1;
  let creates = false;
  while (i < lines.length && /^(new file mode|index) /.test(lines[i])) {
    if (/^new file mode 100644$/.test(lines[i])) creates = true;
    else if (/^new file mode /.test(lines[i])) throw new TestPatchError(`the patch creates ${file} with a mode other than 100644.`);
    i += 1;
  }
  const minus = lines[i] ?? "";
  const plus = lines[i + 1] ?? "";
  if (!(minus === `--- a/${file}` || (creates && minus === "--- /dev/null")) || plus !== `+++ b/${file}`) {
    throw new TestPatchError(`the patch's ---/+++ lines do not name ${file}.`);
  }
  i += 2;
  const hunks: TestPatch["hunks"] = [];
  let added = 0;
  while (i < lines.length) {
    const m = HUNK_RE.exec(lines[i]);
    if (!m) throw new TestPatchError(`unexpected line in the patch: ${JSON.stringify(lines[i].slice(0, 80))}.`);
    const hunk = { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), lines: [] as string[] };
    i += 1;
    let oldSeen = 0;
    let newSeen = 0;
    while (i < lines.length && !HUNK_RE.test(lines[i])) {
      const line = lines[i];
      if (line.startsWith("\\")) throw new TestPatchError("the patch has a `\\ No newline at end of file` marker, which this route does not take.");
      const tag = line[0];
      if (tag === "-") throw new TestPatchError("the patch removes a line: a test-only patch only adds lines.");
      if (tag !== " " && tag !== "+") throw new TestPatchError(`unexpected line in a hunk: ${JSON.stringify(line.slice(0, 80))}.`);
      if (tag === " ") oldSeen += 1;
      else added += 1;
      newSeen += 1;
      hunk.lines.push(line);
      i += 1;
    }
    if (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount) throw new TestPatchError("a hunk's line counts do not match its header.");
    hunks.push(hunk);
  }
  if (hunks.length === 0 || added === 0) throw new TestPatchError("the patch adds no line.");
  if (creates && (hunks.length !== 1 || hunks[0].oldCount !== 0)) throw new TestPatchError("a patch that creates a file must have one hunk with no context.");
  return { file, creates, hunks, added };
}

/**
 * Apply a parsed patch to the file's current bytes (null when it does not exist). Every context
 * line must match exactly where the hunk says; the result is the file the patch leaves.
 */
export function applyTestPatch(patch: TestPatch, original: Buffer | null): Buffer {
  if (patch.creates) {
    if (original !== null) throw new TestPatchError(`the patch creates ${patch.file}, but it already exists.`);
    return Buffer.from(patch.hunks[0].lines.map((l) => l.slice(1)).join("\n") + "\n", "utf8");
  }
  if (original === null) throw new TestPatchError(`${patch.file} does not exist.`);
  const text = original.toString("utf8");
  if (!text.endsWith("\n")) throw new TestPatchError(`${patch.file} does not end with a newline, which this route does not take.`);
  const src = text.slice(0, -1).split("\n");
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of patch.hunks) {
    // With no old lines, the header names the line the insertion follows (git's convention).
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (start < cursor || start > src.length) throw new TestPatchError("a hunk does not fit the file.");
    out.push(...src.slice(cursor, start));
    let at = start;
    for (const line of hunk.lines) {
      if (line[0] === " ") {
        if (src[at] !== line.slice(1)) throw new TestPatchError(`${patch.file}:${at + 1} is not the line the patch expects.`);
        out.push(src[at]);
        at += 1;
      } else out.push(line.slice(1));
    }
    cursor = at;
  }
  out.push(...src.slice(cursor));
  return Buffer.from(out.join("\n") + "\n", "utf8");
}
