/**
 * Does a test file send HTTP requests?
 *
 * The map links a test to a function when the test calls it. A test that reaches the code over
 * HTTP (a request to a route) calls nothing the map can follow, so its functions can read
 * "No linked test" while a test does exercise them. The reports say how many test files are of
 * this kind, so a reader can see the size of that blind spot.
 *
 * A plain static check of the file's text: it imports an HTTP client or a request-level test
 * client, or calls `fetch`. It is a count for a disclosure line, never evidence, and never a link.
 */
const JS_HTTP_MODULES = ["supertest", "superagent", "axios", "got", "node-fetch", "cross-fetch", "undici", "ky", "chai-http", "http", "https", "node:http", "node:https"];
const JS_MODULE_RE = new RegExp(
  `(?:from\\s*|require\\(\\s*|import\\(\\s*|import\\s+)["'](?:${JS_HTTP_MODULES.map((m) => m.replace(/[-/:]/g, "\\$&")).join("|")})["']`
);
const JS_FETCH_RE = /(?<![.\w$])fetch\s*\(/;
const PY_IMPORT_RE = /^\s*(?:import|from)\s+(?:requests|httpx|aiohttp|urllib\.request|urllib3|http\.client)\b/m;
const PY_CLIENT_RE = /\bTestClient\s*\(|\.test_client\s*\(|\bAsyncClient\s*\(|\bAPIClient\s*\(/;
const GO_IMPORT_RE = /"net\/http(?:\/httptest)?"/;
const JVM_RE = /\b(?:MockMvc|WebTestClient|TestRestTemplate|RestTemplate|RestAssured|HttpClient)\b/;

export function sendsHttpRequests(relPath: string, content: string | null | undefined): boolean {
  if (!content) return false;
  const ext = relPath.slice(relPath.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "js": case "jsx": case "mjs": case "cjs": case "ts": case "tsx": case "mts": case "cts":
      return JS_MODULE_RE.test(content) || JS_FETCH_RE.test(content);
    case "py":
      return PY_IMPORT_RE.test(content) || PY_CLIENT_RE.test(content);
    case "go":
      return GO_IMPORT_RE.test(content);
    case "java": case "kt":
      return JVM_RE.test(content);
    default:
      return false;
  }
}
