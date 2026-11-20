import type { ByteSpan, TargetDescription } from "./targetRecord.js";

// The one exact-position format. Every change OrangePro makes to a JavaScript or
// TypeScript function (a whole-body replacement for a proof, or a small edit inside
// the body for a planned fault) names its place with a SourceLocation. Anything that
// proposes such a change (a fault selector, an add-on) uses this format, never its own.
//
// Offsets are raw bytes, half-open `[start, end)`. A location is a claim about one
// file's exact bytes: whoever applies it checks `file_sha256` and `function_sha256`
// first and refuses, by name, on any difference. Nothing falls back to a search by name.

export const SOURCE_LOCATION_VERSION = "orangepro.location.v1" as const;

/**
 * - bound: a member written `owner.name = function` / `F.prototype.name = function`,
 *   checked against the assignment targets written before it (`targets`).
 * - position: every other function with a block body, checked against its own bytes
 *   and the name it is declared under (`name`; `default` for an unnamed default export).
 */
export type LocationRoute = "bound" | "position";

/** A small change strictly inside the body: the bytes found there and the bytes written instead. */
export interface LocationEdit {
  start: number;
  end: number;
  original_sha256: string;
  replacement: string;
}

export interface SourceLocation {
  version: typeof SOURCE_LOCATION_VERSION;
  /** Repo-relative path, forward slashes. */
  file: string;
  file_sha256: string;
  route: LocationRoute;
  /** The name the function is declared under (position route), or the graph symbol's name (bound route). */
  name: string;
  /** Assignment targets written before the function, in order. Bound route only. */
  targets?: string[];
  /** The definition: the statement, property or declaration that holds the function. */
  statement: ByteSpan;
  /** The function-like node. */
  function: ByteSpan;
  function_sha256: string;
  /** The `{ … }` body, from its opening brace to just past its closing brace. */
  body: ByteSpan;
  edit?: LocationEdit;
}

export type LocationResult = { ok: true; location: SourceLocation } | { ok: false; reason: string };

/** The location of a described function, or why it has none (not on an exact-position route, or no block body). */
export function locationOf(file: string, target: TargetDescription): LocationResult {
  const route = target.mutation_route;
  if (route !== "bound" && route !== "position") return { ok: false, reason: `${target.name} is not changed by its exact position (${route}).` };
  if (!target.body) return { ok: false, reason: `${target.name} has no body in braces; there is no block to change.` };
  const name = route === "position" ? target.declared_name : target.name;
  if (!name) return { ok: false, reason: `${target.name} has no declared name on record.` };
  if (route === "bound" && (!target.targets || target.targets.length === 0)) {
    return { ok: false, reason: `no assignment target was found before ${target.name}.` };
  }
  return {
    ok: true,
    location: {
      version: SOURCE_LOCATION_VERSION,
      file,
      file_sha256: target.file_sha256,
      route,
      name,
      ...(route === "bound" ? { targets: [...target.targets!] } : {}),
      statement: { ...target.statement.bytes },
      function: { ...target.function.bytes },
      function_sha256: target.function_sha256,
      body: { ...target.body.bytes }
    }
  };
}

const HEX64 = /^[0-9a-f]{64}$/;
const isOffset = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isSpan = (value: unknown): value is ByteSpan => {
  const span = value as ByteSpan | null;
  return typeof span === "object" && span !== null && isOffset(span.start) && isOffset(span.end) && span.start < span.end;
};

/** Shape checks only. Whether the location matches a file is decided by whoever applies it, against the bytes. */
export function validateLocation(value: unknown): LocationResult {
  const loc = value as Partial<SourceLocation> | null;
  const fail = (reason: string): LocationResult => ({ ok: false, reason });
  if (typeof loc !== "object" || loc === null) return fail("a location must be an object.");
  if (loc.version !== SOURCE_LOCATION_VERSION) return fail(`version must be ${SOURCE_LOCATION_VERSION}.`);
  if (typeof loc.file !== "string" || loc.file === "" || loc.file.startsWith("/") || loc.file.includes("\\") || loc.file.split("/").includes("..")) {
    return fail("file must be a repo-relative path with forward slashes.");
  }
  if (!HEX64.test(String(loc.file_sha256)) || !HEX64.test(String(loc.function_sha256))) return fail("file_sha256 and function_sha256 must be lowercase hex sha256.");
  if (loc.route !== "bound" && loc.route !== "position") return fail("route must be bound or position.");
  if (typeof loc.name !== "string" || loc.name === "") return fail("name is required.");
  if (!isSpan(loc.statement) || !isSpan(loc.function) || !isSpan(loc.body)) return fail("statement, function and body must be byte spans with start < end.");
  if (!(loc.statement.start <= loc.function.start && loc.function.start < loc.body.start && loc.body.end <= loc.function.end)) {
    return fail("the body must lie inside the function, and the function must start inside or after its statement.");
  }
  if (loc.route === "bound" ? !Array.isArray(loc.targets) || loc.targets.length === 0 || loc.targets.some((t) => typeof t !== "string") : loc.targets !== undefined) {
    return fail("targets are required on the bound route and absent on the position route.");
  }
  if (loc.edit !== undefined) {
    const edit = loc.edit;
    if (!isOffset(edit.start) || !isOffset(edit.end) || !HEX64.test(String(edit.original_sha256)) || typeof edit.replacement !== "string") {
      return fail("an edit needs start, end, original_sha256 and replacement.");
    }
    if (!(loc.body.start < edit.start && edit.start < edit.end && edit.end < loc.body.end - 1)) return fail("an edit must lie strictly inside the body.");
  }
  return { ok: true, location: loc as SourceLocation };
}

/**
 * The proof script's arguments for a location. The bound route's arguments are exactly
 * what they were before the position route existed, in the same order.
 */
export function locationArgs(loc: SourceLocation): string[] {
  const args = [
    "--bound-file-sha256",
    loc.file_sha256,
    "--bound-statement-start",
    String(loc.statement.start),
    "--bound-function-start",
    String(loc.function.start),
    "--bound-body-start",
    String(loc.body.start),
    "--bound-body-end",
    String(loc.body.end)
  ];
  if (loc.route === "bound") return [...args, ...(loc.targets ?? []).flatMap((name) => ["--bound-target", name])];
  return [
    ...args,
    "--bound-route",
    "position",
    "--bound-name",
    loc.name,
    "--bound-function-end",
    String(loc.function.end),
    "--bound-function-sha256",
    loc.function_sha256
  ];
}

/** The script's arguments for an edit inside the body, appended after `locationArgs`. */
export function locationEditArgs(edit: LocationEdit): string[] {
  return [
    "--bound-edit-start",
    String(edit.start),
    "--bound-edit-end",
    String(edit.end),
    "--bound-edit-expect-sha256",
    edit.original_sha256,
    "--bound-edit-replacement",
    edit.replacement
  ];
}
