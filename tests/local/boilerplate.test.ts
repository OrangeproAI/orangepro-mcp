import { describe, it, expect } from "vitest";
import { isBoilerplateSymbol } from "../../src/local/analyze/boilerplate.js";

describe("isBoilerplateSymbol — language-aware, conservative", () => {
  describe("Java/Kotlin", () => {
    it("excludes getX/setX/isX ONLY when the body is AST-proven trivial", () => {
      for (const n of ["getId", "setName", "isNew"]) {
        expect(isBoilerplateSymbol(n, "java", "method", true)).toBe(true); // trivial body
        expect(isBoilerplateSymbol(n, "java", "method", false)).toBe(false); // real logic
        expect(isBoilerplateSymbol(n, "java", "method")).toBe(false); // unknown body (regex fallback) — keep
      }
    });
    it("CRITICAL: a getX-named method with real logic stays a behavior (getOwner→repository)", () => {
      // body-aware: trivialAccessor=false (it calls repository.findById)
      expect(isBoilerplateSymbol("getOwner", "java", "method", false)).toBe(false);
    });
    it("excludes object-protocol methods by name (object plumbing)", () => {
      for (const n of ["toString", "equals", "hashCode"]) {
        expect(isBoilerplateSymbol(n, "java", "method")).toBe(true);
      }
    });
    it("keeps real methods that don't match the accessor pattern", () => {
      expect(isBoilerplateSymbol("calculateTotal", "java", "method", true)).toBe(false);
      expect(isBoilerplateSymbol("getopt", "java", "method", true)).toBe(false); // no uppercase after prefix
      expect(isBoilerplateSymbol("process", "java", "method", true)).toBe(false);
    });
    it("never excludes classes", () => {
      expect(isBoilerplateSymbol("getId", "java", "class", true)).toBe(false);
    });
    it("applies the same accessor rule to Kotlin", () => {
      expect(isBoilerplateSymbol("getName", "kotlin", "method", true)).toBe(true);
    });
  });

  describe("Python", () => {
    it("excludes only low-signal dunders", () => {
      expect(isBoilerplateSymbol("__repr__", "python", "function")).toBe(true);
      expect(isBoilerplateSymbol("__str__", "python", "method")).toBe(true);
    });
    it("KEEPS snake_case get_* (often real DB/API logic)", () => {
      for (const n of ["get_projects", "get_user", "is_admin", "set_config", "__init__"]) {
        expect(isBoilerplateSymbol(n, "python", "function")).toBe(false);
      }
    });
  });

  describe("Go and others", () => {
    it("excludes nothing (main may be real wiring)", () => {
      expect(isBoilerplateSymbol("main", "go", "function")).toBe(false);
      expect(isBoilerplateSymbol("GetUser", "go", "function")).toBe(false);
      expect(isBoilerplateSymbol("getId", "ruby", "method")).toBe(false);
    });
  });

  it("only applies to functions/methods, never consts or other kinds", () => {
    expect(isBoilerplateSymbol("getId", "java", "const")).toBe(false);
  });
});
