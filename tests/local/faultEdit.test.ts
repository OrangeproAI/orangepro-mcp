import { afterAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { textControls } from "../../src/local/candidateTest.js";
import { checkFaultEditInput, editForTarget, faultRecordOf, parseFaultSpec, planEdit, replanFromRecord, type FaultEdit } from "../../src/local/contracts/faultRecord.js";
import { locationArgs, locationEditArgs, locationOf } from "../../src/local/contracts/location.js";
import { describeTarget } from "../../src/local/contracts/targetRecord.js";
import { ProofRefusalError } from "../../src/local/operations.js";

import { API_AFTER, editInput, probe, readRun, sha256, tempDirs, workspace } from "./support/probeWorkspace.js";

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const bytes = Buffer.from(API_AFTER);
const described = describeTarget(bytes, "api.seconds");
if (!described.ok) throw new Error("fixture error");
const target = described.target;

/** An edit of the first occurrence of `original` at or after `after`. */
function editOf(original: string, replacement: string, after = "api.seconds"): FaultEdit {
  const start = API_AFTER.indexOf(original, API_AFTER.indexOf(after));
  if (start < 0) throw new Error(`fixture has no ${original}`);
  return { start, end: start + original.length, original_text: original, replacement_text: replacement };
}

describe("planEdit — a fault given as its own edit", () => {
  it("accepts one changed expression: the record carries the edit and the result parses", () => {
    const edit = editOf("value / 1000", "value / 100");
    const planned = planEdit(bytes, target, "lib/api.js", edit);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.operator).toBe("edit");
    expect(planned.plan.parses).toBe(true);
    expect(planned.plan.site.bytes).toEqual({ start: edit.start, end: edit.end });
    expect(planned.plan.mutated.toString("utf8")).toBe(API_AFTER.replace("value / 1000", "value / 100"));
    expect(planned.plan.diff.split("\n").filter((line) => /^[+-][^+-]/.test(line))).toHaveLength(2);
    const record = faultRecordOf(planned.plan, { target_record_sha256: "a".repeat(64), oracle_sha256: "b".repeat(64), symbol_id: "s", file: "lib/api.js", file_sha256: target.file_sha256, function_sha256: target.function_sha256, rationale: "r" });
    expect(record.operator).toEqual({ id: "edit", version: 1 });
    expect(record.original_text).toBe("value / 1000");
    expect(record.replacement_text).toBe("value / 100");
    // Replay needs the record and nothing else.
    const again = replanFromRecord(bytes, target, "lib/api.js", record);
    expect(again.ok && again.plan.mutated_file_sha256).toBe(record.mutated_file_sha256);
    expect(again.ok && sha256(again.plan.diff)).toBe(record.diff.sha256);
  });

  it("accepts a removal inside one expression", () => {
    const planned = planEdit(bytes, target, "lib/api.js", editOf(" / 1000", ""));
    expect(planned.ok && planned.plan.replacement_text).toBe("");
  });

  it("replays an operator's record through the operator, as before", () => {
    const start = API_AFTER.indexOf("Math.floor(value");
    const again = replanFromRecord(bytes, target, "lib/api.js", { operator: { id: "rounding_floor_ceil", version: 1 }, site: { bytes: { start, end: start + 10 }, lines: { start: 1, end: 1 } }, original_text: "Math.floor", replacement_text: "Math.ceil" });
    expect(again.ok && again.plan.operator).toBe("rounding_floor_ceil");
  });

  const refusals: Array<[string, FaultEdit | (() => FaultEdit), string]> = [
    ["the text there is not the original text named", () => ({ ...editOf("value / 1000", "value / 100"), original_text: "value / 1001" }), "edit_mismatch"],
    ["the place is in another function", () => editOf("Math.floor(ms)", "Math.ceil(ms)", "api.label"), "edit_outside_body"],
    ["the edit spans two statements", () => editOf("ms - 0;\n  if (!isNaN(value))", "ms - 1;\n  if (isNaN(value))"), "not_single_site"],
    ["the edit changes spacing only", () => editOf("ms - 0", "ms  -  0"), "no_op_mutation"],
    ["the edit leaves the file unchanged", () => editOf("ms - 0", "ms - 0"), "no_op_mutation"],
    ["the edit changes how the code around it parses", () => editOf("value / 1000", "value / 1000); api.label(1"), "not_single_site"],
    ["the edit swallows the function's closing brace", () => editOf("return null;\n}", "return null;\n} api.x = function () {}"), "edit_outside_body"]
  ];
  for (const [name, make, code] of refusals) {
    it(`refuses when ${name} (${code})`, () => {
      const planned = planEdit(bytes, target, "lib/api.js", typeof make === "function" ? make() : make);
      expect(planned.ok).toBe(false);
      if (!planned.ok) expect(planned.refused).toBe(code);
    });
  }

  it("plans a replacement that does not parse as an invalid mutation, not a refusal", () => {
    const planned = planEdit(bytes, target, "lib/api.js", editOf("value / 1000", "value / / 1000"));
    expect(planned.ok && planned.plan.parses).toBe(false);
  });

  it("is never reachable through --fault: edit is not an operator name", () => {
    expect(parseFaultSpec("edit@10")).toBeNull();
  });

  it("reads an edit in the one location format, with the original text beside it", () => {
    const good = editInput("value / 1000", "value / 100");
    const checked = checkFaultEditInput(good);
    expect(checked.ok).toBe(true);
    const own = locationOf("lib/api.js", target);
    if (!checked.ok || !own.ok) throw new Error("fixture error");
    // Its location must be the target's own; then it is the edit planEdit takes.
    expect(editForTarget(checked.input, own.location)).toEqual({ ok: true, edit: editOf("value / 1000", "value / 100") });
    expect(editForTarget({ ...checked.input, location: { ...checked.input.location, function_sha256: "0".repeat(64) } }, own.location).ok).toBe(false);
    expect(editForTarget({ ...checked.input, location: { ...checked.input.location, name: "api.label" } }, own.location).ok).toBe(false);
    const { edit: _edit, ...noEdit } = good.location;
    for (const bad of [
      null,
      [],
      { location: noEdit, original_text: "value / 1000" },
      { ...good, original_text: "value / 1001" },
      { ...good, original_text: "" },
      { ...good, extra: 1 },
      { location: { ...good.location, version: "other" }, original_text: good.original_text },
      { location: { ...good.location, edit: { ...good.location.edit!, planned_sha256: "nope" } }, original_text: good.original_text }
    ]) {
      expect(checkFaultEditInput(bad).ok).toBe(false);
    }
  });

  it("an edit given as text reaches the proof script in hex with the planned file's hash; an operator's edit as before", () => {
    const own = locationOf("lib/api.js", target);
    if (!own.ok) throw new Error("fixture error");
    const base = { start: 10, end: 14, original_sha256: "a".repeat(64), replacement: "--x" };
    expect(locationEditArgs(base)).toEqual(["--bound-edit-start", "10", "--bound-edit-end", "14", "--bound-edit-expect-sha256", "a".repeat(64), "--bound-edit-replacement", "--x"]);
    expect(locationEditArgs({ ...base, planned_sha256: "b".repeat(64) }).slice(6)).toEqual(["--bound-edit-replacement-hex", Buffer.from("--x").toString("hex"), "--bound-edit-planned-sha256", "b".repeat(64)]);
    expect(locationEditArgs({ ...base, replacement: "", planned_sha256: "b".repeat(64) })[7]).toBe("-");
    expect(locationArgs(own.location)).not.toContain("--bound-edit-start");
  });
});

describe("text controls for an edit", () => {
  const controlsFor = (edit: FaultEdit) => {
    const planned = planEdit(bytes, target, "lib/api.js", edit);
    if (!planned.ok) throw new Error(planned.message);
    return textControls("lib/api.js", bytes, planned.plan.mutated, planned.plan);
  };

  it("keeps each version's behavior and puts the other version's code beside it, on the smallest expression that holds the edit", () => {
    const controls = controlsFor(editOf(" / 1000", ""));
    expect(controls).not.toBeNull();
    expect(controls!.originalText.toString("utf8")).toContain("Math.floor((0 ? (value) : 1 ? (value / 1000) : (value)))");
    expect(controls!.faultText.toString("utf8")).toContain("Math.floor((0 ? (value / 1000) : 1 ? (value) : (value / 1000)))");
  });

  it("does not wrap a method's callee: it moves out to the call", () => {
    const controls = controlsFor(editOf("Math.floor", "Math.round"));
    expect(controls!.originalText.toString("utf8")).toContain("return (0 ? (Math.round(value / 1000)) : 1 ? (Math.floor(value / 1000)) : (Math.round(value / 1000)));");
  });

  it("has no control for an edit that no expression holds", () => {
    expect(controlsFor(editOf("var value = ms - 0;", "var valu2 = ms - 0;"))).toBeNull();
  });
});

describe("probe-fault with an edit", () => {
  it("runs the edit as a fault: the record holds the whole edit and the copies hold exactly its bytes", () => {
    const w = workspace();
    const result = probe(w, "", { fault_edit: editInput("value / 1000", "value / 100") });
    const record = readRun(w, result, "fault-record.json");
    expect(record.operator).toEqual({ id: "edit", version: 1 });
    expect(record.original_text).toBe("value / 1000");
    expect(record.replacement_text).toBe("value / 100");
    expect(record.mutated_file_sha256).toBe(sha256(API_AFTER.replace("value / 1000", "value / 100")));
    expect(["caught_by_existing", "survived_unverified"]).toContain(result.classification.classification);
  }, 60_000);

  it("refuses an edit whose location is not the target's own, before any run", () => {
    const w = workspace();
    const input = editInput("value / 1000", "value / 100");
    let refused: unknown;
    try {
      probe(w, "", { fault_edit: { ...input, location: { ...input.location, function_sha256: "0".repeat(64) } } });
    } catch (e) {
      refused = e;
    }
    expect((refused as ProofRefusalError).code).toBe("edit_mismatch");
  }, 60_000);

  it("refuses an edit no text control can be written for, before any run", () => {
    const w = workspace();
    let refused: unknown;
    try {
      probe(w, "", { fault_edit: editInput("var value = ms - 0;", "var valu2 = ms - 0;") });
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(ProofRefusalError);
    expect((refused as ProofRefusalError).code).toBe("edit_no_control");
  }, 60_000);
});
