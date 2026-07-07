import { describe, it, expect } from "vitest";
import { resolvePrCheckout } from "../../src/local/operations.js";

/** A gh runner that succeeds at version/checkout and reports base branch "main". */
function ghOk(): (args: string[]) => string | null {
  return (args) => {
    if (args[0] === "--version") return "gh version 2.0.0\n";
    if (args[0] === "pr" && args[1] === "checkout") return "";
    if (args[0] === "pr" && args[1] === "view") return "main\n";
    return null;
  };
}

describe("resolvePrCheckout", () => {
  it("rejects a non-positive PR number", () => {
    const r = resolvePrCheckout("/x", 0, { gh: () => "", git: () => "" });
    expect(r.status).toBe("invalid_pr");
  });

  it("reports gh_missing when the GitHub CLI is absent", () => {
    const r = resolvePrCheckout("/x", 5, { gh: () => null, git: () => "" });
    expect(r.status).toBe("gh_missing");
    expect(r.guidance).toMatch(/gh/i);
  });

  it("reports checkout_failed when gh exists but checkout fails", () => {
    const gh = (args: string[]) => (args[0] === "--version" ? "v" : null);
    const r = resolvePrCheckout("/x", 5, { gh, git: () => "", confirmed: true });
    expect(r.status).toBe("checkout_failed");
  });

  it("needs_confirmation: performs NO gh/git mutation when not confirmed", () => {
    const ghCalls: string[][] = [];
    const gitCalls: string[][] = [];
    const gh = (args: string[]) => {
      ghCalls.push(args);
      return ghOk()(args);
    };
    const git = (args: string[]) => {
      gitCalls.push(args);
      return ""; // clean tree
    };
    const r = resolvePrCheckout("/x", 5, { gh, git }); // no `confirmed`
    expect(r.status).toBe("needs_confirmation");
    expect(r.guidance).toMatch(/--yes|--base/);
    // No mutating commands ran: only `gh --version` + `git status --porcelain`.
    expect(ghCalls.every((a) => a[0] === "--version")).toBe(true);
    expect(gitCalls.every((a) => a[0] === "status")).toBe(true);
  });

  it("dirty_tree: refuses even when confirmed if the working tree is dirty", () => {
    const git = (args: string[]) => {
      if (args[0] === "status") return " M src/foo.ts\n";
      return "";
    };
    const r = resolvePrCheckout("/x", 5, { gh: ghOk(), git, confirmed: true });
    expect(r.status).toBe("dirty_tree");
    expect(r.guidance).toMatch(/commit|stash|--base/i);
  });

  it("ok: resolves base to origin/<base> when it exists", () => {
    const git = (args: string[]) => {
      if (args[0] === "status") return ""; // clean
      if (args[0] === "fetch") return "";
      if (args[0] === "rev-parse" && args.includes("origin/main^{commit}")) return "abc\n";
      return null;
    };
    const r = resolvePrCheckout("/x", 5, { gh: ghOk(), git, confirmed: true });
    expect(r.status).toBe("ok");
    expect(r.base_ref).toBe("origin/main");
  });

  it("ok: falls back to the local base when origin/<base> is absent", () => {
    const git = (args: string[]) => {
      if (args[0] === "status") return ""; // clean
      if (args[0] === "fetch") return "";
      if (args[0] === "rev-parse" && args.includes("origin/main^{commit}")) return null;
      if (args[0] === "rev-parse" && args.includes("main^{commit}")) return "abc\n";
      return null;
    };
    const r = resolvePrCheckout("/x", 5, { gh: ghOk(), git, confirmed: true });
    expect(r.status).toBe("ok");
    expect(r.base_ref).toBe("main");
  });
});
