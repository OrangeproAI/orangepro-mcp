import { describe, it, expect } from "vitest";
import { conventionSibling, isConventionLanguage } from "../../src/local/analyze/linkage/conventions.js";

const set = (...paths: string[]): ReadonlySet<string> => new Set(paths);

describe("conventionSibling — per-language predict-and-verify linkage", () => {
  describe("Go", () => {
    it("links foo_test.go to same-package foo.go", () => {
      const got = conventionSibling("pkg/user/auth_test.go", "go", set("pkg/user/auth.go"));
      expect(got?.relPath).toBe("pkg/user/auth.go");
      expect(got?.confidence).toBe(0.7);
      expect(got?.reason).toMatch(/Go test sibling/);
    });
    it("returns null when the source sibling was not scanned", () => {
      expect(conventionSibling("pkg/user/auth_test.go", "go", set("pkg/other/auth.go"))).toBeNull();
    });
    it("does not link a non _test.go file", () => {
      expect(conventionSibling("pkg/user/auth.go", "go", set("pkg/user/auth.go"))).toBeNull();
    });
  });

  describe("JVM (Java/Kotlin)", () => {
    const main = "src/main/java/com/acme/owner/OwnerController.java";
    it("links src/test FooTests to src/main Foo via the mirror (the stem matcher's blind spot)", () => {
      const got = conventionSibling("src/test/java/com/acme/owner/OwnerControllerTests.java", "java", set(main));
      expect(got?.relPath).toBe(main);
      expect(got?.confidence).toBe(0.7);
      expect(got?.reason).toMatch(/src\/test→src\/main mirror/);
    });
    it("handles the IT and TestCase suffixes", () => {
      expect(conventionSibling("src/test/java/com/acme/owner/OwnerControllerIT.java", "java", set(main))?.relPath).toBe(main);
      expect(conventionSibling("src/test/java/com/acme/owner/OwnerControllerTestCase.java", "java", set(main))?.relPath).toBe(main);
    });
    it("falls back to a co-located class when there is no src/test mirror", () => {
      const got = conventionSibling("app/owner/OwnerControllerTest.java", "java", set("app/owner/OwnerController.java"));
      expect(got?.relPath).toBe("app/owner/OwnerController.java");
      expect(got?.confidence).toBe(0.65);
    });
    it("links a Kotlin test", () => {
      const got = conventionSibling("src/test/kotlin/com/acme/PaymentTest.kt", "kotlin", set("src/main/kotlin/com/acme/Payment.kt"));
      expect(got?.relPath).toBe("src/main/kotlin/com/acme/Payment.kt");
    });
    it("returns null when the predicted class was not scanned (no false link)", () => {
      expect(conventionSibling("src/test/java/com/acme/owner/OwnerControllerTests.java", "java", set("src/main/java/com/acme/other/Other.java"))).toBeNull();
    });
    it("does not strip a suffix that would over-match (AuditTest -> Audit, not Audi)", () => {
      expect(conventionSibling("src/test/java/a/AuditTest.java", "java", set("src/main/java/a/Audit.java"))?.relPath).toBe("src/main/java/a/Audit.java");
      expect(conventionSibling("src/test/java/a/AuditTest.java", "java", set("src/main/java/a/Audi.java"))).toBeNull();
    });
  });

  describe("Python", () => {
    it("links test_x.py to same-directory x.py", () => {
      const got = conventionSibling("app/services/test_billing.py", "python", set("app/services/billing.py"));
      expect(got?.relPath).toBe("app/services/billing.py");
      expect(got?.confidence).toBe(0.65);
    });
    it("links x_test.py suffix style too", () => {
      expect(conventionSibling("app/billing_test.py", "python", set("app/billing.py"))?.relPath).toBe("app/billing.py");
    });
    it("mirrors a tests/ directory onto the source tree", () => {
      const got = conventionSibling("app/tests/test_billing.py", "python", set("app/billing.py"));
      expect(got?.relPath).toBe("app/billing.py");
      expect(got?.reason).toMatch(/module mirror/);
    });
    it("mirrors a DEEP tests/ tree onto an unknown package root (the mealie layout)", () => {
      // tests/unit_tests/core/security/providers/test_x.py -> mealie/core/security/providers/x.py
      const src = "mealie/core/security/providers/credentials_provider.py";
      const got = conventionSibling("tests/unit_tests/core/security/providers/test_credentials_provider.py", "python", set(src, "other/credentials_provider.py"));
      expect(got?.relPath).toBe(src);
      expect(got?.confidence).toBe(0.62);
    });
    it("links a flat tests/ layout to a unique module anywhere (the test_ prefix names it)", () => {
      const got = conventionSibling("tests/test_card.py", "python", set("src/card.py"));
      expect(got?.relPath).toBe("src/card.py");
      expect(got?.confidence).toBe(0.5);
      expect(got?.reason).toMatch(/unique module/);
    });
    it("does not guess when the deepest suffix is ambiguous", () => {
      // two modules of the same basename both end with `providers/x.py` — defer to fallback
      const got = conventionSibling("tests/core/providers/test_x.py", "python", set("a/core/providers/x.py", "b/core/providers/x.py"));
      expect(got).toBeNull();
    });
    it("does not guess a flat layout when the module basename is not unique", () => {
      expect(conventionSibling("tests/test_card.py", "python", set("a/card.py", "b/card.py"))).toBeNull();
    });
    it("returns null when no module of that basename was scanned", () => {
      expect(conventionSibling("tests/test_billing.py", "python", set("other.py"))).toBeNull();
    });
  });

  describe("isConventionLanguage — gates the stem fallback", () => {
    it("claims authority for go/java/kotlin/python", () => {
      for (const l of ["go", "java", "kotlin", "python"]) expect(isConventionLanguage(l)).toBe(true);
    });
    it("defers TS/JS and unsupported languages to the stem fallback", () => {
      for (const l of ["typescript", "javascript", "ruby", "other"]) expect(isConventionLanguage(l)).toBe(false);
    });
  });

  describe("languages without a strong convention", () => {
    it("returns null for TS/JS (resolver + stem fallback stay authoritative)", () => {
      expect(conventionSibling("src/card.test.ts", "typescript", set("src/card.ts"))).toBeNull();
      expect(conventionSibling("src/card.test.js", "javascript", set("src/card.js"))).toBeNull();
    });
    it("returns null for unknown languages", () => {
      expect(conventionSibling("a/b_test.rb", "ruby", set("a/b.rb"))).toBeNull();
    });
  });
});
