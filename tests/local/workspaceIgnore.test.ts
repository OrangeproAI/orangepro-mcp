import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { opAnalyze } from "../../src/local/operations.js";
import { loadIgnore, walkFiles } from "../../src/local/util/walk.js";
import {
  initWorkspace,
  LEGACY_ORANGEPROIGNORE_TEMPLATE,
  ORANGEPROIGNORE_TEMPLATE
} from "../../src/local/workspace.js";

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "opro-ignore-"));
}

describe("generated .orangeproignore defaults", () => {
  it("excludes root demo directories without hiding nested language package names", () => {
    const root = tempWorkspace();
    mkdirSync(join(root, "samples"), { recursive: true });
    mkdirSync(join(root, "src/main/java/org/springframework/samples/petclinic"), { recursive: true });
    writeFileSync(join(root, "samples/demo.java"), "class Demo {}\n", "utf8");
    writeFileSync(
      join(root, "src/main/java/org/springframework/samples/petclinic/App.java"),
      "package org.springframework.samples.petclinic; class App {}\n",
      "utf8"
    );

    initWorkspace(root, "2026-07-10T00:00:00.000Z");
    const files = walkFiles(root, loadIgnore(root)).map((file) => file.relPath);

    expect(files).not.toContain("samples/demo.java");
    expect(files).toContain("src/main/java/org/springframework/samples/petclinic/App.java");
  });

  it("migrates an untouched legacy generated template to root-anchored defaults", () => {
    const root = tempWorkspace();
    writeFileSync(join(root, ".orangeproignore"), LEGACY_ORANGEPROIGNORE_TEMPLATE, "utf8");

    initWorkspace(root, "2026-07-10T00:00:00.000Z");

    expect(readFileSync(join(root, ".orangeproignore"), "utf8")).toBe(ORANGEPROIGNORE_TEMPLATE);
  });

  it("applies the migration through analyze for an already-initialized workspace", () => {
    const root = tempWorkspace();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/app.ts"), "export function run() { return true; }\n", "utf8");
    initWorkspace(root, "2026-07-10T00:00:00.000Z");
    writeFileSync(join(root, ".orangeproignore"), LEGACY_ORANGEPROIGNORE_TEMPLATE, "utf8");

    opAnalyze(root, { source: root });

    expect(readFileSync(join(root, ".orangeproignore"), "utf8")).toBe(ORANGEPROIGNORE_TEMPLATE);
  });

  it("preserves a user-edited legacy ignore file", () => {
    const root = tempWorkspace();
    const edited = `${LEGACY_ORANGEPROIGNORE_TEMPLATE}custom-output/\n`;
    writeFileSync(join(root, ".orangeproignore"), edited, "utf8");

    initWorkspace(root, "2026-07-10T00:00:00.000Z");

    expect(readFileSync(join(root, ".orangeproignore"), "utf8")).toBe(edited);
  });
});
