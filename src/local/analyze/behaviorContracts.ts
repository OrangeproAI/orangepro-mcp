import { slugify } from "../util/ids.js";

export type BehaviorContractKind = "http_endpoint";
export type BehaviorContractFramework = "nestjs" | "express" | "fastify" | "file_route";

export interface BehaviorContract {
  id: string;
  title: string;
  kind: BehaviorContractKind;
  framework: BehaviorContractFramework;
  method: string;
  path: string;
  file: string;
  handler?: string;
  controller?: string;
  source: "framework";
}

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "options", "head", "all"]);
// Known limits for this v1 metadata extractor:
// - only literal route strings are captured;
// - custom/composed decorators are not expanded;
// - computed router methods/paths are ignored.
// That is intentional while Endpoint nodes are informational only and excluded
// from the coverage denominator.
const NEST_METHOD_DECORATOR = /@(Get|Post|Put|Delete|Patch|Options|Head|All)\s*\(\s*(?:(["'`])([^"'`]*)\2)?\s*\)(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*?(?:public\s+|private\s+|protected\s+|async\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
const NEST_CONTROLLER_DECORATOR = /@Controller\s*\(\s*(?:(["'`])([^"'`]*)\1)?\s*\)\s*(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const EXPRESS_ROUTER_CALL = /\b(?:router|app)\s*\.\s*(get|post|put|delete|patch|options|head|all)\s*\(\s*(["'`])([^"'`]*)\2\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?|\([^)]*\)\s*=>|async\s+\([^)]*\)\s*=>|function\s+[A-Za-z_$][A-Za-z0-9_$]*)/gi;
const EXPRESS_ROUTE_CHAIN = /\b(?:router|app)\s*\.\s*route\s*\(\s*(["'`])([^"'`]*)\1\s*\)((?:\s*\.\s*(?:get|post|put|delete|patch|options|head|all)\s*\([^)]*\))+)/gi;
const CHAINED_METHOD_CALL = /\.\s*(get|post|put|delete|patch|options|head|all)\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?|\([^)]*\)\s*=>|async\s+\([^)]*\)\s*=>|function\s+[A-Za-z_$][A-Za-z0-9_$]*)/gi;
const FASTIFY_CALL = /\bfastify\s*\.\s*(get|post|put|delete|patch|options|head|all)\s*\(\s*(["'`])([^"'`]*)\2\s*,\s*(?:\{[^)]*\}\s*,\s*)?([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?|\([^)]*\)\s*=>|async\s+\([^)]*\)\s*=>|function\s+[A-Za-z_$][A-Za-z0-9_$]*)/gi;
const FILE_ROUTE_EXPORT = /\bexport\s+(?:(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD|ALL)\s*\(|const\s+(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD|ALL)\s*=)/g;

export function extractBehaviorContracts(content: string, file: string): BehaviorContract[] {
  return dedupeContracts([
    ...extractFileRouteContracts(content, file),
    ...extractNestContracts(content, file),
    ...extractRouterContracts(content, file, EXPRESS_ROUTER_CALL, "express"),
    ...extractExpressRouteChains(content, file),
    ...extractRouterContracts(content, file, FASTIFY_CALL, "fastify")
  ]);
}

function extractFileRouteContracts(content: string, file: string): BehaviorContract[] {
  const path = fileRoutePath(file);
  if (!path) return [];
  const contracts: BehaviorContract[] = [];
  for (const match of content.matchAll(FILE_ROUTE_EXPORT)) {
    const method = httpMethod(match[1] ?? match[2]);
    contracts.push(makeContract({
      file,
      framework: "file_route",
      method,
      path,
      handler: method
    }));
  }
  return contracts;
}

function extractNestContracts(content: string, file: string): BehaviorContract[] {
  const controllers = [...content.matchAll(NEST_CONTROLLER_DECORATOR)].map((match) => ({
    index: match.index ?? 0,
    path: normalizeRoutePath(match[2] ?? ""),
    name: match[3]
  }));
  if (controllers.length === 0) return [];
  const contracts: BehaviorContract[] = [];
  for (const match of content.matchAll(NEST_METHOD_DECORATOR)) {
    const index = match.index ?? 0;
    const controller = nearestController(controllers, index);
    const method = httpMethod(match[1]);
    const routePath = joinRoutePaths(controller?.path ?? "", match[3] ?? "");
    const handler = match[4];
    contracts.push(makeContract({
      file,
      framework: "nestjs",
      method,
      path: routePath,
      handler,
      controller: controller?.name
    }));
  }
  return contracts;
}

function nearestController(controllers: Array<{ index: number; path: string; name: string }>, index: number) {
  let current: { index: number; path: string; name: string } | undefined;
  for (const controller of controllers) {
    if (controller.index <= index) current = controller;
    else break;
  }
  return current;
}

function extractRouterContracts(
  content: string,
  file: string,
  pattern: RegExp,
  framework: Extract<BehaviorContractFramework, "express" | "fastify">
): BehaviorContract[] {
  const contracts: BehaviorContract[] = [];
  for (const match of content.matchAll(pattern)) {
    const handler = handlerName(match[4]);
    contracts.push(makeContract({
      file,
      framework,
      method: httpMethod(match[1]),
      path: normalizeRoutePath(match[3] ?? ""),
      handler
    }));
  }
  return contracts;
}

function extractExpressRouteChains(content: string, file: string): BehaviorContract[] {
  const contracts: BehaviorContract[] = [];
  for (const match of content.matchAll(EXPRESS_ROUTE_CHAIN)) {
    const path = normalizeRoutePath(match[2] ?? "");
    const chain = match[3] ?? "";
    for (const methodMatch of chain.matchAll(CHAINED_METHOD_CALL)) {
      contracts.push(makeContract({
        file,
        framework: "express",
        method: httpMethod(methodMatch[1]),
        path,
        handler: handlerName(methodMatch[2])
      }));
    }
  }
  return contracts;
}

function makeContract(input: {
  file: string;
  framework: BehaviorContractFramework;
  method: string;
  path: string;
  handler?: string;
  controller?: string;
}): BehaviorContract {
  const title = `${input.method} ${input.path}`;
  return {
    id: `endpoint:${slugify(`${input.method}-${input.path}-${input.file}-${input.handler ?? ""}`)}`,
    title,
    kind: "http_endpoint",
    framework: input.framework,
    method: input.method,
    path: input.path,
    file: input.file,
    handler: input.handler,
    controller: input.controller,
    source: "framework"
  };
}

function httpMethod(value: string): string {
  const lower = value.toLowerCase();
  return HTTP_METHODS.has(lower) ? lower.toUpperCase() : value.toUpperCase();
}

function normalizeRoutePath(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : "/";
}

function fileRoutePath(file: string): string | null {
  const normalized = file.replace(/\\/g, "/");
  if (!/(^|\/)route\.[cm]?[jt]sx?$/.test(normalized)) return null;
  const parts = normalized.split("/");
  const apiIndex = parts.findIndex((part) => part === "api" || part === "apis");
  if (apiIndex === -1) return null;
  const routeParts = parts.slice(apiIndex + 1, -1).map((part) =>
    part
      .replace(/^\[\[\.\.\.(.+)\]\]$/, ":$1*")
      .replace(/^\[\.\.\.(.+)\]$/, ":$1*")
      .replace(/^\[(.+)\]$/, ":$1")
  );
  return normalizeRoutePath(routeParts.join("/"));
}

function joinRoutePaths(prefix: string, route: string): string {
  const parts = [prefix, route].map((part) => part.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
  return parts.length ? `/${parts.join("/")}` : "/";
}

function handlerName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith("async") || trimmed.startsWith("(") || trimmed.startsWith("function")) return undefined;
  return trimmed;
}

function dedupeContracts(contracts: BehaviorContract[]): BehaviorContract[] {
  const seen = new Set<string>();
  const output: BehaviorContract[] = [];
  for (const contract of contracts) {
    const key = `${contract.framework}:${contract.method}:${contract.path}:${contract.file}:${contract.handler ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(contract);
  }
  return output;
}
