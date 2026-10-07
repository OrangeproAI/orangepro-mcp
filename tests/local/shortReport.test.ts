import { describe, expect, it } from "vitest";

import { denominatorNoun, permalink, repoWebFromRemote, shortReportPath, storeLabel } from "../../src/local/viz/shortReport.js";

describe("short report helpers", () => {
  it("writes next to the detailed report with a short_ prefix", () => {
    expect(shortReportPath("/w/.orangepro/behavior-coverage.html")).toBe("/w/.orangepro/short_behavior-coverage.html");
    expect(shortReportPath("report.html")).toBe("short_report.html");
  });

  it("links only to known hosts and never keeps credentials from the remote", () => {
    expect(repoWebFromRemote("git@github.com:acme/shop.git")).toEqual({ base: "https://github.com/acme/shop", host: "github" });
    expect(repoWebFromRemote("https://user:s3cret-token@github.com/acme/shop.git")).toEqual({ base: "https://github.com/acme/shop", host: "github" });
    expect(repoWebFromRemote("ssh://git@gitlab.com/group/sub/proj.git")).toEqual({ base: "https://gitlab.com/group/sub/proj", host: "gitlab" });
    expect(repoWebFromRemote("https://git.internal.example/acme/shop.git")).toBeNull();
    expect(repoWebFromRemote("https://github.com/")).toBeNull();
    expect(repoWebFromRemote("")).toBeNull();
    expect(repoWebFromRemote(null)).toBeNull();
    expect(repoWebFromRemote("/local/path/repo")).toBeNull();
  });

  it("builds commit permalinks with encoded paths and a line anchor", () => {
    const gh = { base: "https://github.com/acme/shop", host: "github" as const };
    const gl = { base: "https://gitlab.com/acme/shop", host: "gitlab" as const };
    expect(permalink(gh, "abc123", "src/a b/x.py", 12)).toBe("https://github.com/acme/shop/blob/abc123/src/a%20b/x.py#L12");
    expect(permalink(gl, "abc123", "src/x.py")).toBe("https://gitlab.com/acme/shop/-/blob/abc123/src/x.py");
  });

  it("names the data a delete removes from the names in the call, else from the owning class", () => {
    expect(storeLabel("OrdersRepository(conn).table.delete")).toBe("Orders");
    expect(storeLabel("HTTPRouteRepository(db_conn).table.delete")).toBe("HTTP route");
    expect(storeLabel("self._session_cache.delete")).toBe("Session cache");
    expect(storeLabel("self.queue_client.delete")).toBe("Queue");
    expect(storeLabel("self._settings_table.delete")).toBe("Settings");
    expect(storeLabel("self.table.delete", "sym:app/accounts.py#AccountsRepository.remove_by_id")).toBe("Accounts");
    expect(storeLabel("this.store.deleteExpired", "sym:src/store/gc.ts#Gc.sweep")).toBe("");
    expect(storeLabel("s.store.DeleteRun", "sym:pkg/run.go#purge")).toBe("");
    // Abbreviations and option bags name nothing a reader recognizes; acronyms do.
    expect(storeLabel("e.pm.Delete", "sym:pkg/exec.go#executor.handlePause")).toBe("");
    expect(storeLabel("a.opts.Reader.DeleteItem")).toBe("Reader");
    expect(storeLabel("MCPRepository(conn).table.delete")).toBe("MCP");
  });

  it("uses a noun that matches what the denominator counts", () => {
    expect(denominatorNoun({ functionLike: 95, classes: 5, total: 100 }).plural).toBe("functions");
    expect(denominatorNoun({ functionLike: 60, classes: 38, total: 100 }).plural).toBe("functions and classes");
    expect(denominatorNoun({ functionLike: 40, classes: 20, total: 100 }).plural).toBe("code symbols");
    expect(denominatorNoun(undefined).plural).toBe("functions");
  });
});
