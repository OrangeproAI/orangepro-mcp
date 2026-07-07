#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function usage() {
  return [
    "Usage: node scripts/spikes/dynamic-proof-nest-typeorm-recipe.mjs --root <repo> --repo-name <name> --spec <rel.spec.ts> --service <rel.ts> --service-class <Class> --entity <rel.ts> --entity-class <Class> --method <name> --assert-property <prop> --seed-json <json-array> --expected-json <json-array> --wrong-json <json-value> --equivalent-json <json-value> --out-config <path> [--jest-config <rel>]",
    "",
    "Generates a narrow Nest + TypeORM sqljs integration spec plus a two-case dynamic-proof config.",
    "The generated cases follow the breadth guardrail: one genuine proving mutation and one equivalent mutation expected to survive.",
    "This is a spike helper for trusted disposable checkouts; it does not modify product graph state."
  ].join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    args[key] = value;
    i += 1;
  }
  for (const required of [
    "root",
    "repoName",
    "spec",
    "service",
    "serviceClass",
    "entity",
    "entityClass",
    "method",
    "assertProperty",
    "seedJson",
    "expectedJson",
    "wrongJson",
    "equivalentJson",
    "outConfig"
  ]) {
    if (!Object.prototype.hasOwnProperty.call(args, required)) {
      throw new Error(`Missing required --${required.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`);
    }
  }
  return args;
}

function assertIdentifier(value, label) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) {
    throw new Error(`${label} must be a JavaScript identifier`);
  }
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function resolveInside(root, relPath, label) {
  if (path.isAbsolute(relPath)) {
    throw new Error(`${label} must be relative to --root`);
  }
  const resolved = path.resolve(root, relPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes --root`);
  }
  return resolved;
}

function importPath(fromRel, toRel) {
  const fromDir = path.dirname(fromRel);
  let rel = path.relative(fromDir, toRel).replaceAll(path.sep, "/").replace(/\.[cm]?tsx?$/, "");
  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }
  return rel;
}

function renderSpec(args, seed, expected) {
  const serviceImport = importPath(args.spec, args.service);
  const entityImport = importPath(args.spec, args.entity);
  const seedLiteral = JSON.stringify(seed, null, 2).replace(/\n/g, "\n      ");
  const expectedLiteral = JSON.stringify([...expected].sort());
  return `import { Test } from "@nestjs/testing";
import { TypeOrmModule, getRepositoryToken } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ${args.entityClass} } from "${entityImport}";
import { ${args.serviceClass} } from "${serviceImport}";

describe("${args.serviceClass}.${args.method} generated sqljs integration", () => {
  let service: ${args.serviceClass};
  let repo: Repository<${args.entityClass}>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: "sqljs",
          autoSave: false,
          entities: [${args.entityClass}],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([${args.entityClass}]),
      ],
      providers: [${args.serviceClass}],
    }).compile();

    service = module.get<${args.serviceClass}>(${args.serviceClass});
    repo = module.get<Repository<${args.entityClass}>>(getRepositoryToken(${args.entityClass}));
    await repo.save(${seedLiteral});
  });

  it("returns expected ${args.assertProperty} values from the local TypeORM repository", async () => {
    const rows = await service.${args.method}();
    expect(rows.map(row => row.${args.assertProperty}).sort()).toEqual(${expectedLiteral});
  });
});
`;
}

function renderConfig(args, wrong, equivalent) {
  const withOptionalConfig = testCase => {
    if (args.jestConfig) {
      testCase.jestConfig = args.jestConfig;
    }
    return testCase;
  };
  return {
    cases: [
      withOptionalConfig({
        repo: args.repoName,
        name: `${args.serviceClass}.${args.method} genuine wrong result`,
        root: path.resolve(args.root),
        test: args.spec,
        target: args.service,
        method: args.method,
        replacement: `return ${JSON.stringify(wrong)};`,
        replacementMode: "promise-json",
        runner: "jest",
        expected: "proven",
        testEnv: {
          OPRO_TEST_DATABASE_URL: `sqljs://${args.repoName}`
        }
      }),
      withOptionalConfig({
        repo: args.repoName,
        name: `${args.serviceClass}.${args.method} equivalent result`,
        root: path.resolve(args.root),
        test: args.spec,
        target: args.service,
        method: args.method,
        replacement: `return ${JSON.stringify(equivalent)};`,
        replacementMode: "promise-json",
        runner: "jest",
        expected: "associated_survived",
        testEnv: {
          OPRO_TEST_DATABASE_URL: `sqljs://${args.repoName}`
        }
      })
    ]
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  for (const [value, label] of [
    [args.serviceClass, "--service-class"],
    [args.entityClass, "--entity-class"],
    [args.method, "--method"],
    [args.assertProperty, "--assert-property"]
  ]) {
    assertIdentifier(value, label);
  }
  const seed = parseJson(args.seedJson, "--seed-json");
  const expected = parseJson(args.expectedJson, "--expected-json");
  const wrong = parseJson(args.wrongJson, "--wrong-json");
  const equivalent = parseJson(args.equivalentJson, "--equivalent-json");
  if (!Array.isArray(seed) || !Array.isArray(expected)) {
    throw new Error("--seed-json and --expected-json must both be JSON arrays");
  }
  resolveInside(root, args.service, "--service");
  resolveInside(root, args.entity, "--entity");
  const specAbs = resolveInside(root, args.spec, "--spec");
  const specSource = renderSpec(args, seed, expected);
  const config = renderConfig(args, wrong, equivalent);

  mkdirSync(path.dirname(specAbs), { recursive: true });
  writeFileSync(specAbs, specSource);
  writeFileSync(path.resolve(args.outConfig), `${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write(JSON.stringify({
    spec: args.spec,
    outConfig: path.resolve(args.outConfig),
    cases: config.cases.length
  }, null, 2));
  process.stdout.write("\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
}
