import { describe, it, expect, beforeAll } from "vitest";
import { preloadTreeSitter, extractTreeSitterStructure, extractTreeSitterSymbols, treeSitterReady } from "../../src/local/analyze/treeSitter/engine.js";

beforeAll(async () => {
  await preloadTreeSitter(["java", "python", "go", "ruby", "kotlin", "rust", "php", "csharp", "swift", "c", "cpp"]);
});

const names = (content: string, lang: string) =>
  extractTreeSitterSymbols(content, lang).symbols.map((s) => `${s.name}/${s.symbol_kind}`).sort();

describe("tree-sitter extraction (PR-1, language-agnostic)", () => {
  it("loads the grammars", () => {
    expect(treeSitterReady("java")).toBe(true);
    expect(treeSitterReady("python")).toBe(true);
    expect(treeSitterReady("go")).toBe(true);
    expect(treeSitterReady("ruby")).toBe(true);
    expect(treeSitterReady("kotlin")).toBe(true);
    expect(treeSitterReady("rust")).toBe(true);
    expect(treeSitterReady("php")).toBe(true);
    expect(treeSitterReady("csharp")).toBe(true);
    expect(treeSitterReady("swift")).toBe(true);
    expect(treeSitterReady("c")).toBe(true);
    expect(treeSitterReady("cpp")).toBe(true);
  });

  it("Java: package-private class + handler methods (the regex missed both)", () => {
    const java = [
      "package x;",
      "@Controller",
      "class OwnerController {", // package-private — no `public`
      "  public OwnerController(OwnerRepository r) { this.r = r; }", // constructor: NOT a behavior
      "  private final String FIELD = \"v\";", // field: NOT a behavior
      "  @GetMapping(\"/owners\")",
      "  public String processFindForm() { return \"x\"; }",
      "  String packagePrivateHelper() { return \"y\"; }",
      "}"
    ].join("\n");
    const got = names(java, "java");
    expect(got).toContain("OwnerController/class");
    expect(got).toContain("processFindForm/method");
    expect(got).toContain("packagePrivateHelper/method");
    expect(got).not.toContain("OwnerController/method"); // constructor excluded
    expect(got).not.toContain("FIELD/method"); // field excluded
  });

  it("Python: free functions + class + methods", () => {
    const py = ["def top_level():", "    pass", "", "class Service:", "    def do_work(self):", "        pass"].join("\n");
    const got = names(py, "python");
    expect(got).toContain("top_level/function");
    expect(got).toContain("Service/class");
    expect(got).toContain("do_work/function"); // a method is a function_definition; still a behavior
  });

  it("Go: functions AND receiver methods (regex only caught top-level funcs)", () => {
    const go = ["package x", "func Top() {}", "func (r *Repo) Save() error { return nil }", "type Repo struct {}"].join("\n");
    const got = names(go, "go");
    expect(got).toContain("Top/function");
    expect(got).toContain("Save/method"); // receiver method — the missed surface
    expect(got).toContain("Repo/class");
  });

  it("does NOT extract symbols from comments or strings", () => {
    const py = ['x = "def fake(): pass"', "# def also_fake():", "def real():", "    pass"].join("\n");
    const got = names(py, "python");
    expect(got).toEqual(["real/function"]);
  });

  it("Ruby: extracts modules, classes, instance methods, and singleton methods", () => {
    expect(
      names(
        [
          "module Billing",
          "  class User",
          "    def save",
          "    end",
          "    def self.find(id)",
          "    end",
          "    def User.build",
          "    end",
          "  end",
          "  def helper",
          "  end",
          "end"
        ].join("\n"),
        "ruby"
      )
    ).toEqual(["Billing/class", "User/class", "build/method", "find/method", "helper/method", "save/method"]);
  });

  it("PHP: extracts namespaced class, interface, trait, enum, function, and method surfaces", () => {
    expect(
      names(
        [
          "<?php",
          "namespace App\\Billing;",
          "interface Payable { public function pay(): void; }",
          "trait Logs { protected function log() {} }",
          "enum Status { case Paid; }",
          "class User { public function save() {} }",
          "function helper() {}"
        ].join("\n"),
        "php"
      )
    ).toEqual([
      "Logs/class",
      "Payable/class",
      "Status/class",
      "User/class",
      "helper/function",
      "log/method",
      "pay/method",
      "save/method"
    ]);
  });

  it("C#: extracts interfaces, records, record structs, structs, enums, and methods", () => {
    expect(
      names(
        [
          "namespace App.Billing;",
          "public interface IPayable { void Pay(); }",
          "public record User(int Id) { public void Save() {} }",
          "public record struct Receipt(int Id);",
          "public struct Money { public decimal Amount; public void Normalize() {} }",
          "public enum Status { Paid }"
        ].join("\n"),
        "csharp"
      )
    ).toEqual([
      "IPayable/class",
      "Money/class",
      "Normalize/method",
      "Pay/method",
      "Receipt/class",
      "Save/method",
      "Status/class",
      "User/class"
    ]);
  });

  it("Ruby/Kotlin/Rust/PHP/C#/Swift/C/C++: extracts language surfaces through config only", () => {
    expect(names(["class User", "  def save", "  end", "end", "def helper", "end"].join("\n"), "ruby")).toEqual(["User/class", "helper/method", "save/method"]);
    expect(names(["class User { fun save() {} }", "fun top() {}"].join("\n"), "kotlin")).toEqual(["User/class", "save/function", "top/function"]);
    expect(names(["struct User { id: i32 }", "impl User { pub fn save(&self) {} }", "pub fn top() {}"].join("\n"), "rust")).toEqual([
      "User/class",
      "save/function",
      "top/function"
    ]);
    expect(names(["<?php", "class User { public function save() {} }", "function helper() {}"].join("\n"), "php")).toEqual([
      "User/class",
      "helper/function",
      "save/method"
    ]);
    expect(names("class User { public void Save() {} }", "csharp")).toEqual(["Save/method", "User/class"]);
    expect(names(["class User { func save() {} }", "func top() {}"].join("\n"), "swift")).toEqual(["User/class", "save/function", "top/function"]);
    expect(names(["struct user { int id; };", "int helper(int x) { return x; }"].join("\n"), "c")).toEqual(["helper/function", "user/class"]);
    expect(names(["class User { public: void save(); };", "void User::save() {}", "int helper() { return 1; }"].join("\n"), "cpp")).toEqual([
      "User/class",
      "helper/function",
      "save/function"
    ]);
  });

  it("Kotlin: extracts classes, objects, interface functions, and top-level functions", () => {
    const got = names(
      ["class User { fun save() {} }", "object Registry { fun lookup() {} }", "interface Repo { fun find(): User }", "fun top() {}"].join("\n"),
      "kotlin"
    );
    expect(got).toEqual(["Registry/class", "Repo/class", "User/class", "find/function", "lookup/function", "save/function", "top/function"]);
  });

  it("Swift: extracts nominal types plus protocol function requirements", () => {
    const got = names(
      [
        "class User { func save() {} }",
        "struct Account { func persist() {} }",
        "protocol Repo { func find() }",
        "enum State { case ready; func apply() {} }",
        "func top() {}"
      ].join("\n"),
      "swift"
    );
    expect(got).toEqual([
      "Account/class",
      "Repo/class",
      "State/class",
      "User/class",
      "apply/function",
      "find/function",
      "persist/function",
      "save/function",
      "top/function"
    ]);
  });

  it("Rust: extracts trait signatures but skips aliases and extern declarations", () => {
    const got = names(
      [
        "struct User { id: i32 }",
        "trait Repo { fn find(&self); fn defaulted(&self) {} }",
        'extern "C" { fn imported(x: i32); }',
        "type UserId = i32;",
        "impl User { pub fn save(&self) {} }",
        "pub fn top() {}"
      ].join("\n"),
      "rust"
    );
    expect(got).toEqual(["Repo/class", "User/class", "defaulted/function", "find/function", "save/function", "top/function"]);
  });

  it("C++: does not turn macro-wrapped namespaces into fake functions", () => {
    const got = names(["FMT_BEGIN_NAMESPACE", "namespace detail {", "int real() { return 1; }", "}"].join("\n"), "cpp");
    expect(got).toContain("real/function");
    expect(got).not.toContain("FMT_BEGIN_NAMESPACE/function");
    expect(got).not.toContain("class/function");
  });

  it("C: under-emits C++ header syntax instead of minting keyword symbols", () => {
    const got = names(["struct stat* s;", "enum { is_enabled = 1 };", "enum class Color { red };", "class User { public: void save(); };", "int real() { return 1; }"].join("\n"), "c");
    expect(got).toContain("real/function");
    expect(got).not.toContain("stat/class");
    expect(got).not.toContain("is_enabled/class");
    expect(got).not.toContain("class/class");
    expect(got).not.toContain("Color/function");
    expect(got).not.toContain("User/function");
  });

  it("C/C++: counts only real type definitions, not type references", () => {
    expect(names("struct user { int id; };\nstruct stat* s;", "c")).toEqual(["user/class"]);
    expect(names("class User { public: void save(); };\nUser* user;", "cpp")).toEqual(["User/class"]);
  });

  it("returns [] for an unconfigured language", () => {
    expect(extractTreeSitterSymbols("defmodule X do end", "elixir").symbols).toEqual([]);
  });

  it("extracts Java package/imports and qualified calls as metadata-only structure", () => {
    const st = extractTreeSitterStructure(
      [
        "package app.web;",
        "import app.service.UserService;",
        "class Controller {",
        "  void show() { UserService.load(); }",
        "}"
      ].join("\n"),
      "java"
    );
    expect(st.packageName).toBe("app.web");
    expect(st.imports).toEqual([{ local: "UserService", module: "app.service.UserService", imported: "UserService", kind: "named" }]);
    expect(st.calls).toContainEqual({ caller: "show", callee: "load", qualifier: "UserService", via: "qualified", shadowed: [] });
  });

  it("extracts Python imports and calls, including aliases", () => {
    const st = extractTreeSitterStructure(
      ["from app.services.user import load_user as load", "import app.db as db", "def show():", "    load()", "    db.connect()"].join("\n"),
      "python"
    );
    expect(st.imports).toEqual([
      { local: "load", module: "app.services.user", imported: "load_user", kind: "named" },
      { local: "db", module: "app.db", kind: "module" }
    ]);
    expect(st.calls).toContainEqual({ caller: "show", callee: "load", via: "free", shadowed: [] });
    expect(st.calls).toContainEqual({ caller: "show", callee: "connect", qualifier: "db", via: "qualified", shadowed: [] });
  });

  it("extracts Go imports and selector calls", () => {
    const st = extractTreeSitterStructure(
      ["package web", 'import svc "github.com/acme/app/service"', "func Show(){ svc.Load() }"].join("\n"),
      "go"
    );
    expect(st.packageName).toBe("web");
    expect(st.imports).toEqual([{ local: "svc", module: "github.com/acme/app/service", kind: "module" }]);
    expect(st.calls).toContainEqual({ caller: "Show", callee: "Load", qualifier: "svc", via: "qualified", shadowed: [] });
  });
});
