import { describe, it, expect } from "vitest";
import { classifyTestLayer } from "../../src/local/analyze/testLayer.js";

describe("classifyTestLayer — AST/framework-aware layer (Phase 4.6)", () => {
  it("RTL import / render call -> component (high)", () => {
    const c = classifyTestLayer(
      "src/Login.test.tsx",
      `import { render, screen } from "@testing-library/react";
       import { Login } from "./Login.js";
       test("x", () => { render(<Login/>); expect(screen.getByRole("button")).toBeVisible(); });`
    );
    expect(c.layer).toBe("component");
    expect(c.confidence).toBe("high");
    expect(c.signals.length).toBeGreaterThan(0);
  });

  it("supertest -> api (high)", () => {
    const c = classifyTestLayer(
      "tests/users.test.ts",
      `import request from "supertest";
       import { app } from "../src/app.js";
       it("x", async () => { await request(app).get("/users").expect(200); });`
    );
    expect(c.layer).toBe("api");
    expect(c.confidence).toBe("high");
  });

  it("page.goto / playwright -> e2e (high)", () => {
    const c = classifyTestLayer(
      "tests/login.spec.ts",
      `import { test, expect } from "@playwright/test";
       test("x", async ({ page }) => { await page.goto("/login"); await expect(page).toHaveURL(/dashboard/); });`
    );
    expect(c.layer).toBe("e2e");
    expect(c.confidence).toBe("high");
  });

  it("cypress cy.visit -> e2e (high)", () => {
    const c = classifyTestLayer(
      "cypress/e2e/checkout.cy.ts",
      `describe("x", () => { it("y", () => { cy.visit("/checkout"); cy.contains("Pay"); }); });`
    );
    expect(c.layer).toBe("e2e");
  });

  it("testcontainers / db client -> integration (high)", () => {
    const c = classifyTestLayer(
      "tests/repo.test.ts",
      `import { GenericContainer } from "testcontainers";
       import { Pool } from "pg";
       it("x", async () => { /* spin a container */ expect(1).toBe(1); });`
    );
    expect(c.layer).toBe("integration");
  });

  it("single in-repo module called directly -> unit (medium)", () => {
    const c = classifyTestLayer(
      "tests/sum.test.ts",
      `import { sum } from "../src/sum.js";
       it("adds", () => { expect(sum(1, 2)).toBe(3); });`
    );
    expect(c.layer).toBe("unit");
    expect(c.confidence).toBe("medium");
  });

  it("no decisive signal -> unknown, NEVER defaulted to unit", () => {
    const c = classifyTestLayer(
      "tests/weird.test.ts",
      `it("just math", () => { expect(1 + 1).toBe(2); });`
    );
    expect(c.layer).toBe("unknown");
    expect(c.confidence).toBe("none");
  });

  it("e2e wins over component when both signals are present (precedence)", () => {
    const c = classifyTestLayer(
      "tests/flow.test.tsx",
      `import { test } from "@playwright/test";
       import { render } from "@testing-library/react";
       test("x", async ({ page }) => { await page.goto("/"); render(<div/>); });`
    );
    expect(c.layer).toBe("e2e");
  });

  it("non-TS/JS file falls back to a path hint at low confidence", () => {
    const c = classifyTestLayer("e2e/test_login.py", null);
    expect(c.layer).toBe("e2e");
    expect(c.confidence).toBe("low");
  });

  it("a path under /api/ alone does NOT upgrade past unknown (no AST signal)", () => {
    const c = classifyTestLayer(
      "src/api/handler.test.ts",
      `it("pure", () => { expect(2).toBe(2); });`
    );
    expect(c.layer).toBe("unknown");
  });
});

describe("classifyTestLayer — false-positive hardening (Phase 4.6 review)", () => {
  it("a type-only DB-client import does NOT make a unit test 'integration'", () => {
    const c = classifyTestLayer(
      "tests/query.test.ts",
      `import type { Pool } from "pg";
       import { buildQuery } from "../src/query.js";
       it("builds", () => { expect(buildQuery({})).toBe("SELECT 1"); });`
    );
    expect(c.layer).toBe("unit");
  });

  it("a local request() helper does NOT make a unit test 'api'", () => {
    const c = classifyTestLayer(
      "tests/client.test.ts",
      `import { makeClient } from "../src/client.js";
       it("calls", () => { const cl = makeClient(); expect(cl.request("ping")).toBe("pong"); });`
    );
    expect(c.layer).toBe("unit");
  });

  it("a local variable named `page` does NOT make a unit test 'e2e'", () => {
    const c = classifyTestLayer(
      "tests/paginate.test.ts",
      `import { paginate } from "../src/paginate.js";
       it("paginates", () => { const page = paginate([1, 2, 3], 1); expect(page.next()).toBe(2); });`
    );
    expect(c.layer).toBe("unit");
  });

  it("a pure unit test living under an e2e/ directory is NOT forced to 'e2e' by the path", () => {
    const c = classifyTestLayer(
      "e2e/utils/format.test.ts",
      `import { fmt } from "../../src/fmt.js";
       it("formats", () => { expect(fmt(1)).toBe("1"); });`
    );
    expect(c.layer).toBe("unit");
  });
});
