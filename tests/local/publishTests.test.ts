import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { recordBytes } from "../../src/local/contracts/io.js";
import { gitBlobSha, opPublishTests } from "../../src/local/publishTests.js";
import { BUILD, MERGED, TEST_AFTER, TEST_BEFORE, proofRunFixture } from "./support/proofRunFixture.js";

const TOKEN = "ghs_sentinel_token_value_0123456789";
const REPO = "example/round";

/** A small in-memory GitHub: refs, commits, trees and PRs, enough for publish-tests' calls. */
function fakeGitHub(opts: { baseSha?: string } = {}) {
  const blobs = new Map<string, Buffer>([[gitBlobSha(Buffer.from(TEST_BEFORE)), Buffer.from(TEST_BEFORE)]]);
  const trees = new Map<string, Record<string, string>>([["tree0", { "test/round.js": gitBlobSha(Buffer.from(TEST_BEFORE)) }]]);
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>([[MERGED, { tree: "tree0", parents: [], message: "merge" }]]);
  const refs = new Map<string, string>([["heads/main", opts.baseSha ?? MERGED]]);
  const pulls: any[] = [];
  const calls: string[] = [];
  let writes = 0;
  let n = 0;
  const id = (prefix: string) => createHash("sha1").update(`${prefix}${++n}`).digest("hex");
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers as HeadersInit).get("authorization");
    calls.push(`${method} ${u.pathname}${u.search} auth=${auth === `Bearer ${TOKEN}`}`);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const p = u.pathname.replace(`/repos/${REPO}`, "");
    if (method !== "GET") writes += 1;
    let m: RegExpMatchArray | null;
    if (method === "GET" && (m = p.match(/^\/git\/ref\/(.+)$/))) return refs.has(m[1]) ? json(200, { object: { sha: refs.get(m[1]) } }) : json(404, { message: "Not Found" });
    if (method === "GET" && (m = p.match(/^\/git\/commits\/([0-9a-f]+)$/))) return commits.has(m[1]) ? json(200, { sha: m[1], tree: { sha: commits.get(m[1])!.tree }, message: commits.get(m[1])!.message }) : json(404, {});
    if (method === "GET" && (m = p.match(/^\/contents\/(.+)$/))) {
      const tree = trees.get(commits.get(u.searchParams.get("ref") ?? "")?.tree ?? "") ?? {};
      const sha = tree[decodeURIComponent(m[1])];
      return sha ? json(200, { type: "file", encoding: "base64", sha, content: blobs.get(sha)!.toString("base64") }) : json(404, { message: "Not Found" });
    }
    if (method === "POST" && p === "/git/blobs") {
      const bytes = Buffer.from(body.content, "base64");
      const sha = gitBlobSha(bytes);
      blobs.set(sha, bytes);
      return json(201, { sha });
    }
    if (method === "POST" && p === "/git/trees") {
      const t = { ...(trees.get(body.base_tree) ?? {}) };
      for (const e of body.tree) t[e.path] = e.sha;
      const sha = id("tree");
      trees.set(sha, t);
      return json(201, { sha });
    }
    if (method === "POST" && p === "/git/commits") {
      const sha = id("commit");
      commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
      return json(201, { sha });
    }
    if (method === "POST" && p === "/git/refs") {
      refs.set(body.ref.replace(/^refs\//, ""), body.sha);
      return json(201, {});
    }
    if (method === "PATCH" && (m = p.match(/^\/git\/refs\/(.+)$/))) {
      refs.set(m[1], body.sha);
      return json(200, {});
    }
    if (method === "GET" && p === "/pulls") return json(200, pulls.filter((pr) => `example:${pr.head.ref}` === u.searchParams.get("head")));
    if (method === "POST" && p === "/pulls") {
      const pr = { number: 40 + pulls.length, html_url: `https://github.com/${REPO}/pull/${40 + pulls.length}`, draft: body.draft, state: "open", merged: false, title: body.title, body: body.body, base: { ref: body.base }, head: { ref: body.head } };
      pulls.push(pr);
      return json(201, pr);
    }
    if ((m = p.match(/^\/pulls\/(\d+)(\/files)?$/))) {
      const pr = pulls.find((x) => x.number === Number(m![1]));
      if (!pr) return json(404, {});
      if (method === "PATCH") {
        pr.body = body.body;
        return json(200, pr);
      }
      const headSha = refs.get(`heads/${pr.head.ref}`)!;
      if (m[2]) {
        const tree = trees.get(commits.get(headSha)!.tree)!;
        const files = Object.keys(tree).filter((f) => tree[f] !== trees.get("tree0")![f]);
        return json(200, files.map((filename) => ({ filename })));
      }
      return json(200, { ...pr, head: { ...pr.head, sha: headSha } });
    }
    return json(500, { message: `fake GitHub has no ${method} ${p}` });
  }) as typeof fetch;
  return { fetchImpl, calls, refs, pulls, blobs, get writes() { return writes; } };
}

const env = { GITHUB_TOKEN: TOKEN, ORANGEPRO_GITHUB_API_URL: "http://127.0.0.1:9" } as NodeJS.ProcessEnv;
const deps = (gh: ReturnType<typeof fakeGitHub>, extra: Record<string, unknown> = {}) => ({ fetch: gh.fetchImpl, env, build_sha256: BUILD, now: () => 1_800_000_000_000, ...extra });

describe("opro publish-tests: the trusted draft-PR publisher (no repository code, no git)", () => {
  it("without --yes: the plan only, no request at all", async () => {
    const f = proofRunFixture();
    const gh = fakeGitHub();
    const res = await opPublishTests({ from_run: f.exportDir, repo: REPO, base: "main" }, deps(gh));
    expect(res.status).toBe("dry_run");
    expect(res.plan).toMatchObject({ branch: "orangepro/tests/246f6f5aeeba", base: "main", file: "test/round.js", title: "OrangePro: a test for round (246f6f5aeeba)" });
    expect(gh.calls).toEqual([]);
    expect(res.record).toBeNull();
  });

  it("with --yes: one commit on the branch, one draft PR, read back; a rerun opens nothing new", async () => {
    const f = proofRunFixture();
    const gh = fakeGitHub();
    const res = await opPublishTests({ from_run: f.exportDir, repo: REPO, base: "main", yes: true, out: f.runs }, deps(gh));
    expect(res.status).toBe("delivered");
    expect(res.record?.pr).toMatchObject({ number: 40, url: "https://github.com/example/round/pull/40", draft: true, base_ref: "main", files: ["test/round.js"] });
    expect(gh.pulls).toHaveLength(1);
    expect(gh.blobs.get(gitBlobSha(Buffer.from(TEST_AFTER)))?.toString()).toBe(TEST_AFTER);
    expect(gh.calls.every((c) => c.endsWith("auth=true"))).toBe(true);
    const writes = gh.writes;
    const again = await opPublishTests({ from_run: f.exportDir, repo: REPO, base: "main", yes: true, out: f.runs }, deps(gh, { now: () => 1_800_000_000_001 }));
    expect(again.status).toBe("unchanged");
    expect(again.record?.pr?.number).toBe(40);
    expect(gh.pulls).toHaveLength(1);
    expect(gh.writes).toBe(writes); // no new commit, no new PR, the same body
    // The token is in no file written and in no result.
    for (const id of readdirSync(f.runs)) for (const name of ["delivery-record.json", "delivery.md"]) {
      try {
        expect(readFileSync(join(f.runs, id, name), "utf8")).not.toContain(TOKEN);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    expect(JSON.stringify([res, again])).not.toContain(TOKEN);
  });

  it("the base moved since the proof: stale_base, and no write", async () => {
    const f = proofRunFixture();
    const gh = fakeGitHub({ baseSha: "9".repeat(40) });
    const res = await opPublishTests({ from_run: f.exportDir, repo: REPO, base: "main", yes: true, out: f.runs }, deps(gh));
    expect(res).toMatchObject({ status: "stale_base", reason: "base_moved" });
    expect(gh.writes).toBe(0);
  });

  it("the branch holds a commit OrangePro did not write: diverged, and no write", async () => {
    const f = proofRunFixture();
    const gh = fakeGitHub();
    gh.refs.set("heads/orangepro/tests/246f6f5aeeba", MERGED);
    const res = await opPublishTests({ from_run: f.exportDir, repo: REPO, base: "main", yes: true, out: f.runs }, deps(gh));
    expect(res).toMatchObject({ status: "diverged", reason: "branch_not_ours" });
    expect(gh.writes).toBe(0);
  });

  it("refuses, before any request: not verified, a changed file, another build, another commit, a non-test path, no token", async () => {
    const cases: Array<[string, () => Promise<{ status: string; reason: string | null }>, string]> = [
      ["inconclusive", async () => opPublishTests({ from_run: proofRunFixture({ fault: "inconclusive" }).exportDir, repo: REPO, base: "main", yes: true }, deps(fakeGitHub())), "not_verified"],
      ["tampered", async () => {
        const f = proofRunFixture();
        appendFileSync(join(f.exportDir, "orangepro-tests.patch"), "+x\n");
        return opPublishTests({ from_run: f.exportDir, repo: REPO, base: "main", yes: true }, deps(fakeGitHub()));
      }, "export_run_invalid"],
      ["build", async () => opPublishTests({ from_run: proofRunFixture().exportDir, repo: REPO, base: "main", yes: true }, deps(fakeGitHub(), { build_sha256: "c".repeat(64) })), "build_mismatch"],
      ["commit", async () => opPublishTests({ from_run: proofRunFixture().exportDir, repo: REPO, base: "main", merged: "8".repeat(40), yes: true }, deps(fakeGitHub())), "commit_mismatch"],
      ["never path", async () => opPublishTests({ from_run: proofRunFixture({ neverPaths: ["test/round.js"] }).exportDir, repo: REPO, base: "main", yes: true }, deps(fakeGitHub())), "not_test_only"],
      ["no token", async () => opPublishTests({ from_run: proofRunFixture().exportDir, repo: REPO, base: "main", yes: true }, deps(fakeGitHub(), { env: {} })), "no_token"],
      ["api host", async () => opPublishTests({ from_run: proofRunFixture().exportDir, repo: REPO, base: "main", yes: true }, deps(fakeGitHub(), { env: { GITHUB_TOKEN: TOKEN, ORANGEPRO_GITHUB_API_URL: "https://evil.example" } })), "api_url"]
    ];
    for (const [name, run, reason] of cases) {
      const res = await run();
      expect([name, res.reason]).toEqual([name, reason]);
      expect(["refused", "not_deliverable", "blocked"]).toContain(res.status);
    }
  });

  it("the patch does not apply to the file at the merged commit: refused, no write", async () => {
    const f = proofRunFixture();
    const gh = fakeGitHub();
    const other = Buffer.from(TEST_BEFORE.replace("2000), 2", "2000), 3"));
    const sha = gitBlobSha(other);
    gh.blobs.set(sha, other);
    // point the merged commit's tree at a different test file
    const res = await opPublishTests({ from_run: f.exportDir, repo: REPO, base: "main", yes: true, out: f.runs }, deps({ ...gh, fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/contents/test/round.js")) return new Response(JSON.stringify({ type: "file", encoding: "base64", sha, content: other.toString("base64") }), { status: 200 });
      return gh.fetchImpl(url, init);
    }) as typeof fetch }));
    expect(res).toMatchObject({ status: "refused", reason: "patch_does_not_apply" });
    expect(gh.writes).toBe(0);
  });

  it("--from-actions: delivers only when result.json says verified_gap", async () => {
    const f = proofRunFixture();
    writeFileSync(join(f.repo, ".orangepro", "result.json"), recordBytes({ status: "needs_test", runs: { export: null } }));
    const res = await opPublishTests({ from_actions: join(f.repo, ".orangepro"), repo: REPO, base: "main", yes: true }, deps(fakeGitHub()));
    expect(res).toMatchObject({ status: "not_deliverable", reason: "not_verified" });
  });
});
