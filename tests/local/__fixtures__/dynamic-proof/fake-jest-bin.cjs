#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function assertionLine(testAbs) {
  const lines = readFileSync(testAbs, "utf8").split(/\r?\n/);
  const index = lines.findIndex(line => /\bexpect\s*\(/.test(line));
  return index === -1 ? 1 : index + 1;
}

const rootDir = argValue("--rootDir") ?? process.cwd();
const testRel = argValue("--runTestsByPath");
const reportPath = process.env.OPRO_DYNAMIC_PROOF_REPORT;
if (!rootDir || !testRel || !reportPath) {
  process.stderr.write("fake jest missing rootDir/test/report\n");
  process.exit(2);
}

const testAbs = path.resolve(rootDir, testRel);
const serviceAbs = path.resolve(rootDir, "src/order.service.ts");
const service = readFileSync(serviceAbs, "utf8");
const substituted = /substituted|use-class|override-provider/.test(testRel);
const mutantChanged = service.includes("\"mutant-order\"") || service.includes("return null");
const failed = mutantChanged && !substituted;
const line = assertionLine(testAbs);
const report = {
  testResults: [{
    name: testAbs,
    assertionResults: [{
      ancestorTitles: ["fake jest"],
      fullName: "fake jest assertion",
      status: failed ? "failed" : "passed",
      title: "assertion",
      failureMessages: failed
        ? [`Error: expect(received).toBe(expected)\n    at ${testAbs}:${line}:5`]
        : [],
      failureDetails: []
    }]
  }]
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.exit(failed ? 1 : 0);
