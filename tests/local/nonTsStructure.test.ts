import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";

const dirs: string[] = [];

beforeAll(async () => {
  await preloadTreeSitter(["java", "python", "go", "ruby", "kotlin", "rust", "php", "csharp", "swift", "c", "cpp"]);
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-nonts-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function edgeStrings(root: string, type: "IMPORTS" | "CALLS"): string[] {
  return analyzeRepo(root, { readContent: true })
    .edges.filter((e) => e.relationship_type === type)
    .map((e) => `${e.from_external_id} -> ${e.to_external_id}`)
    .sort();
}

describe("non-TS structural imports/calls", () => {
  it("Java: emits exact import and imported static/member call edges", () => {
    const root = repo({
      "src/main/java/app/service/UserService.java": [
        "package app.service;",
        "class UserService {",
        "  static void load() {}",
        "}"
      ].join("\n"),
      "src/main/java/app/web/Controller.java": [
        "package app.web;",
        "import app.service.UserService;",
        "class Controller {",
        "  void show() { UserService.load(); }",
        "}"
      ].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain(
      "src/main/java/app/web/Controller.java -> src/main/java/app/service/UserService.java"
    );
    expect(edgeStrings(root, "CALLS")).toContain(
      "sym:src/main/java/app/web/Controller.java#show -> sym:src/main/java/app/service/UserService.java#load"
    );
  });

  it("Java: catch and enhanced-for variables shadow imported class qualifiers", () => {
    const root = repo({
      "src/main/java/app/service/UserService.java": [
        "package app.service;",
        "class UserService extends Exception {",
        "  void load() {}",
        "}"
      ].join("\n"),
      "src/main/java/app/web/Controller.java": [
        "package app.web;",
        "import app.service.UserService;",
        "class Controller {",
        "  void caught() { try {} catch (UserService UserService) { UserService.load(); } }",
        "  void loop(java.util.List<UserService> xs) { for (UserService UserService : xs) { UserService.load(); } }",
        "}"
      ].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain(
      "src/main/java/app/web/Controller.java -> src/main/java/app/service/UserService.java"
    );
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("Python: resolves unique module imports and qualified calls", () => {
    const root = repo({
      "src/app/db.py": "def connect():\n    pass\n",
      "src/app/view.py": ["import app.db as db", "def show():", "    db.connect()"].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("src/app/view.py -> src/app/db.py");
    expect(edgeStrings(root, "CALLS")).toContain("sym:src/app/view.py#show -> sym:src/app/db.py#connect");
  });

  it("Python: resolves named imports but not when a local binding shadows the imported name", () => {
    const root = repo({
      "src/app/db.py": "def connect():\n    pass\n",
      "src/app/good.py": ["from app.db import connect", "def show():", "    connect()"].join("\n"),
      "src/app/shadowed.py": ["from app.db import connect", "def show(connect):", "    connect()"].join("\n")
    });
    const calls = edgeStrings(root, "CALLS");
    expect(calls).toContain("sym:src/app/good.py#show -> sym:src/app/db.py#connect");
    expect(calls).not.toContain("sym:src/app/shadowed.py#show -> sym:src/app/db.py#connect");
  });

  it("Python: same-file symbols shadow named imports instead of misresolving", () => {
    const root = repo({
      "src/app/db.py": "def connect():\n    pass\n",
      "src/app/view.py": [
        "from app.db import connect",
        "def connect():",
        "    pass",
        "def show():",
        "    connect()"
      ].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("src/app/view.py -> src/app/db.py");
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("Python: loop, except, and lambda bindings shadow named imports", () => {
    const root = repo({
      "src/app/other.py": "def validate():\n    pass\n",
      "src/app/view.py": [
        "from app.other import validate",
        "def run(items):",
        "    for validate in items:",
        "        validate()",
        "    try:",
        "        pass",
        "    except Exception as validate:",
        "        validate()",
        "    f = lambda validate: validate()"
      ].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("src/app/view.py -> src/app/other.py");
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("Python: comprehension targets shadow named imports", () => {
    const root = repo({
      "src/app/other.py": "def validate():\n    pass\n",
      "src/app/view.py": [
        "from app.other import validate",
        "def run():",
        "    return [validate() for validate in [lambda: 1]]"
      ].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("src/app/view.py -> src/app/other.py");
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("Python: nested local functions do not impersonate top-level emitted symbols", () => {
    const root = repo({
      "src/app/db.py": "def connect():\n    pass\n",
      "src/app/view.py": [
        "from app.db import connect",
        "def helper():",
        "    pass",
        "def outer():",
        "    def helper():",
        "        connect()",
        "    helper()"
      ].join("\n")
    });
    const calls = edgeStrings(root, "CALLS");
    expect(calls).not.toContain("sym:src/app/view.py#helper -> sym:src/app/db.py#connect");
    expect(calls).not.toContain("sym:src/app/view.py#outer -> sym:src/app/db.py#connect");
  });

  it("Python: ambiguous module suffixes underlink instead of guessing", () => {
    const root = repo({
      "src/a/util.py": "def load():\n    pass\n",
      "src/b/util.py": "def load():\n    pass\n",
      "src/app/view.py": ["import util", "def show():", "    util.load()"].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toEqual([]);
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("Go: resolves module-local package imports when the package maps to one product file", () => {
    const root = repo({
      "go.mod": "module github.com/acme/app\n",
      "service/service.go": "package service\nfunc Load() {}\n",
      "web/web.go": ['package web', 'import svc "github.com/acme/app/service"', "func Show(){ svc.Load() }"].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("web/web.go -> service/service.go");
    expect(edgeStrings(root, "CALLS")).toContain("sym:web/web.go#Show -> sym:service/service.go#Load");
  });

  it("Go: multi-file package imports skip file-level IMPORTS but still resolve unique package calls", () => {
    const root = repo({
      "go.mod": "module github.com/acme/app\n",
      "service/a.go": "package service\nfunc Load() {}\n",
      "service/b.go": "package service\nfunc Save() {}\n",
      "web/web.go": ['package web', 'import svc "github.com/acme/app/service"', "func Show(){ svc.Load() }"].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toEqual([]);
    expect(edgeStrings(root, "CALLS")).toContain("sym:web/web.go#Show -> sym:service/a.go#Load");
  });

  it("Go: range variables shadow imported package qualifiers", () => {
    const root = repo({
      "go.mod": "module github.com/acme/app\n",
      "config/config.go": "package config\nfunc Do() {}\n",
      "web/web.go": [
        "package web",
        "import \"github.com/acme/app/config\"",
        "type Runner interface { Do() }",
        "func Run(items []Runner){ for _, config := range items { config.Do() } }"
      ].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("web/web.go -> config/config.go");
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("Ruby: resolves require_relative to the exact local file", () => {
    const root = repo({
      "app/user.rb": "class User\nend\n",
      "app/controller.rb": ["require_relative \"user\"", "class Controller", "end"].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("app/controller.rb -> app/user.rb");
  });

  it("Ruby: does not resolve load-path require or root-relative escapes", () => {
    const root = repo({
      "user.rb": "class User\nend\n",
      "app/controller.rb": ["require \"user\"", "class Controller", "end"].join("\n"),
      "main.rb": ["require_relative \"../user\"", "class Main", "end"].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toEqual([]);
  });

  it("Kotlin: resolves imported classes by package-qualified name", () => {
    const root = repo({
      "src/main/kotlin/app/service/UserService.kt": "package app.service\nclass UserService\n",
      "src/main/kotlin/app/web/Controller.kt": "package app.web\nimport app.service.UserService\nclass Controller\n"
    });
    expect(edgeStrings(root, "IMPORTS")).toContain(
      "src/main/kotlin/app/web/Controller.kt -> src/main/kotlin/app/service/UserService.kt"
    );
  });

  it("Kotlin: resolves named top-level function imports and free calls", () => {
    const root = repo({
      "src/main/kotlin/app/service/UserService.kt": "package app.service\nfun load() {}\n",
      "src/main/kotlin/app/web/Controller.kt":
        "package app.web\nimport app.service.load\nfun show() { load() }\n"
    });
    expect(edgeStrings(root, "IMPORTS")).toContain(
      "src/main/kotlin/app/web/Controller.kt -> src/main/kotlin/app/service/UserService.kt"
    );
    expect(edgeStrings(root, "CALLS")).toContain(
      "sym:src/main/kotlin/app/web/Controller.kt#show -> sym:src/main/kotlin/app/service/UserService.kt#load"
    );
  });

  it("Kotlin: local values shadow imported function calls", () => {
    const root = repo({
      "src/main/kotlin/app/service/UserService.kt": "package app.service\nfun load() {}\n",
      "src/main/kotlin/app/web/Controller.kt":
        "package app.web\nimport app.service.load\nfun show() { val load = {}; load() }\n"
    });
    expect(edgeStrings(root, "IMPORTS")).toContain(
      "src/main/kotlin/app/web/Controller.kt -> src/main/kotlin/app/service/UserService.kt"
    );
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("Kotlin: parameters shadow imported function calls", () => {
    const root = repo({
      "src/main/kotlin/app/service/UserService.kt": "package app.service\nfun load() {}\n",
      "src/main/kotlin/app/web/Controller.kt":
        "package app.web\nimport app.service.load\nfun show(load: () -> Unit) { load() }\n"
    });
    expect(edgeStrings(root, "IMPORTS")).toContain(
      "src/main/kotlin/app/web/Controller.kt -> src/main/kotlin/app/service/UserService.kt"
    );
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("Kotlin: catch parameters shadow imported function calls", () => {
    const root = repo({
      "src/main/kotlin/app/service/UserService.kt": "package app.service\nfun load() {}\n",
      "src/main/kotlin/app/web/Controller.kt": [
        "package app.web",
        "import app.service.load",
        "class LoadEx : Exception() { operator fun invoke() {} }",
        "fun show() { try { throw LoadEx() } catch (load: LoadEx) { load() } }"
      ].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain(
      "src/main/kotlin/app/web/Controller.kt -> src/main/kotlin/app/service/UserService.kt"
    );
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("Kotlin: same-file top-level functions shadow imported function calls", () => {
    const root = repo({
      "src/main/kotlin/app/other/Other.kt": "package app.other\nfun validate() {}\n",
      "src/main/kotlin/app/Main.kt": [
        "package app",
        "import app.other.validate",
        "fun validate() {}",
        "fun caller() { validate() }"
      ].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain(
      "src/main/kotlin/app/Main.kt -> src/main/kotlin/app/other/Other.kt"
    );
    expect(edgeStrings(root, "CALLS")).toContain(
      "sym:src/main/kotlin/app/Main.kt#caller -> sym:src/main/kotlin/app/Main.kt#validate"
    );
    expect(edgeStrings(root, "CALLS")).not.toContain(
      "sym:src/main/kotlin/app/Main.kt#caller -> sym:src/main/kotlin/app/other/Other.kt#validate"
    );
  });

  it("Kotlin: extension receiver names do not become same-file call targets", () => {
    const root = repo({
      "src/main/kotlin/app/Main.kt": [
        "package app",
        "class ZipFile",
        "fun ZipFile.unzip() {}",
        "fun transform() { ZipFile() }"
      ].join("\n")
    });
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("Kotlin: duplicate package-qualified symbols underlink instead of guessing", () => {
    const root = repo({
      "src/main/kotlin/a/UserService.kt": "package app.service\nfun load() {}\n",
      "src/main/kotlin/b/UserService.kt": "package app.service\nfun load() {}\n",
      "src/main/kotlin/app/web/Controller.kt":
        "package app.web\nimport app.service.load\nfun show() { load() }\n"
    });
    expect(edgeStrings(root, "IMPORTS")).toEqual([]);
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("Kotlin: nested local functions are not package-import targets", () => {
    const root = repo({
      "src/main/kotlin/app/service/Helpers.kt":
        "package app.service\nfun outer() { fun load() {}; load() }\n",
      "src/main/kotlin/app/web/Controller.kt":
        "package app.web\nimport app.service.load\nfun show() { load() }\n"
    });
    expect(edgeStrings(root, "IMPORTS")).toEqual([]);
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("Kotlin: member functions are not package-import targets", () => {
    const root = repo({
      "src/main/kotlin/app/service/UserService.kt":
        "package app.service\nclass UserService { fun load() {} }\n",
      "src/main/kotlin/app/web/Controller.kt":
        "package app.web\nimport app.service.load\nfun show() { load() }\n"
    });
    expect(edgeStrings(root, "IMPORTS")).toEqual([]);
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("Kotlin: qualified class calls stay underlinked in v1", () => {
    const root = repo({
      "src/main/kotlin/app/service/UserService.kt": "package app.service\nclass UserService { fun load() {} }\n",
      "src/main/kotlin/app/web/Controller.kt":
        "package app.web\nimport app.service.UserService\nfun show() { UserService.load() }\n"
    });
    expect(edgeStrings(root, "IMPORTS")).toContain(
      "src/main/kotlin/app/web/Controller.kt -> src/main/kotlin/app/service/UserService.kt"
    );
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("Kotlin: wildcard imports underlink instead of guessing", () => {
    const root = repo({
      "src/main/kotlin/app/service/UserService.kt": "package app.service\nclass UserService\n",
      "src/main/kotlin/app/web/Controller.kt": "package app.web\nimport app.service.*\nclass Controller\n"
    });
    expect(edgeStrings(root, "IMPORTS")).toEqual([]);
  });

  it("Rust: resolves local mod/use declarations to the exact module file", () => {
    const root = repo({
      "src/service.rs": "pub fn load() {}\n",
      "src/main.rs": ["mod service;", "use crate::service::load;", "fn show() { load(); }"].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("src/main.rs -> src/service.rs");
    expect(edgeStrings(root, "CALLS")).toContain("sym:src/main.rs#show -> sym:src/service.rs#load");
  });

  it("Rust: resolves module-qualified calls through exact local mod declarations", () => {
    const root = repo({
      "src/service.rs": "pub fn load() {}\n",
      "src/main.rs": ["mod service;", "fn show() { service::load(); }"].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("src/main.rs -> src/service.rs");
    expect(edgeStrings(root, "CALLS")).toContain("sym:src/main.rs#show -> sym:src/service.rs#load");
  });

  it("Rust: resolves explicit crate-qualified calls through exact local modules", () => {
    const root = repo({
      "src/service.rs": "pub fn load() {}\n",
      "src/main.rs": ["mod service;", "fn show() { crate::service::load(); }"].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("src/main.rs -> src/service.rs");
    expect(edgeStrings(root, "CALLS")).toContain("sym:src/main.rs#show -> sym:src/service.rs#load");
  });

  it("Rust: resolves crate-qualified calls in manifest-root sibling layouts", () => {
    const root = repo({
      "crates/core/Cargo.toml": "[package]\nname = \"core\"\nversion = \"0.1.0\"\n",
      "crates/core/messages.rs": "pub fn set_errored() {}\n",
      "crates/core/main.rs": ["mod messages;", "fn show() { crate::messages::set_errored(); }"].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("crates/core/main.rs -> crates/core/messages.rs");
    expect(edgeStrings(root, "CALLS")).toContain(
      "sym:crates/core/main.rs#show -> sym:crates/core/messages.rs#set_errored"
    );
  });

  it("Rust: same module path in separate crate roots stays scoped", () => {
    const root = repo({
      "crates/a/Cargo.toml": "[package]\nname = \"a\"\nversion = \"0.1.0\"\n",
      "crates/a/messages.rs": "pub fn load() {}\n",
      "crates/a/main.rs": ["mod messages;", "fn show() { crate::messages::load(); }"].join("\n"),
      "crates/b/Cargo.toml": "[package]\nname = \"b\"\nversion = \"0.1.0\"\n",
      "crates/b/messages.rs": "pub fn load() {}\n",
      "crates/b/main.rs": ["mod messages;", "fn show() { crate::messages::load(); }"].join("\n")
    });
    expect(edgeStrings(root, "CALLS")).toEqual([
      "sym:crates/a/main.rs#show -> sym:crates/a/messages.rs#load",
      "sym:crates/b/main.rs#show -> sym:crates/b/messages.rs#load"
    ]);
  });

  it("Rust: local let bindings shadow imported call names", () => {
    const root = repo({
      "src/service.rs": "pub fn load() {}\n",
      "src/main.rs": ["mod service;", "use crate::service::load;", "fn show() { let load = || {}; load(); }"].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("src/main.rs -> src/service.rs");
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("Rust: for-loop and closure parameters shadow imported call names", () => {
    const root = repo({
      "src/service.rs": "pub fn load() {}\n",
      "src/main.rs": [
        "mod service;",
        "use crate::service::load;",
        "fn show(items: Vec<fn()>) {",
        "  for load in items { load(); }",
        "  let _f = |load: fn()| load();",
        "}"
      ].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("src/main.rs -> src/service.rs");
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("Rust: nested functions do not impersonate top-level emitted symbols", () => {
    const root = repo({
      "src/service.rs": "pub fn load() {}\n",
      "src/main.rs": [
        "mod service;",
        "use crate::service::load;",
        "fn helper() {}",
        "fn outer() {",
        "  fn helper() { load(); }",
        "  helper();",
        "}"
      ].join("\n")
    });
    const calls = edgeStrings(root, "CALLS");
    expect(calls).not.toContain("sym:src/main.rs#helper -> sym:src/service.rs#load");
    expect(calls).not.toContain("sym:src/main.rs#outer -> sym:src/service.rs#load");
  });

  it("Rust: grouped use declarations underlink instead of guessing", () => {
    const root = repo({
      "src/service.rs": "pub fn load() {}\n",
      "src/main.rs": ["use crate::service::{load};", "fn show() { load(); }"].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toEqual([]);
  });

  it("Rust: inline modules do not resolve to same-named sibling files", () => {
    const root = repo({
      "src/service.rs": "pub fn load() {}\n",
      "src/main.rs": ["mod service { pub fn load() {} }", "fn show() { service::load(); }"].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toEqual([]);
  });

  it("Rust: does not resolve bare external-crate uses to same-named local files", () => {
    const root = repo({
      "src/log.rs": "pub fn info() {}\n",
      "src/main.rs": ["use log::info;", "fn show() { info(); }"].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toEqual([]);
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("PHP: resolves namespace use clauses to the exact class file", () => {
    const root = repo({
      "src/Service/UserService.php": "<?php\nnamespace App\\Service;\nclass UserService {}\n",
      "src/Web/Controller.php": "<?php\nnamespace App\\Web;\nuse App\\Service\\UserService;\nclass Controller {}\n"
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("src/Web/Controller.php -> src/Service/UserService.php");
  });

  it("PHP: resolves static calls only through a single matching imported class file", () => {
    const root = repo({
      "src/Service/UserService.php": "<?php\nnamespace App\\Service;\nclass UserService { static function load() {} }\n",
      "src/Web/Controller.php": "<?php\nnamespace App\\Web;\nuse App\\Service\\UserService;\nclass Controller { function show() { UserService::load(); } }\n"
    });
    expect(edgeStrings(root, "CALLS")).toContain("sym:src/Web/Controller.php#show -> sym:src/Service/UserService.php#load");
  });

  it("PHP: free calls do not resolve to imported classes", () => {
    const root = repo({
      "src/Service/Helper.php": "<?php\nnamespace App\\Service;\nclass Helper {}\n",
      "src/Web/Controller.php": "<?php\nnamespace App\\Web;\nuse App\\Service\\Helper;\nfunction caller() { Helper(); }\n"
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("src/Web/Controller.php -> src/Service/Helper.php");
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("PHP: does not resolve static calls when the target file has multiple classes", () => {
    const root = repo({
      "src/Service/UserService.php": "<?php\nnamespace App\\Service;\nclass UserService {}\nclass Other { static function load() {} }\n",
      "src/Web/Controller.php": "<?php\nnamespace App\\Web;\nuse App\\Service\\UserService;\nclass Controller { function show() { UserService::load(); } }\n"
    });
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("C#: resolves a using namespace only when it maps to one local file", () => {
    const root = repo({
      "Service/UserService.cs": "namespace App.Service;\nclass UserService {}\n",
      "Web/Controller.cs": "using App.Service;\nnamespace App.Web;\nclass Controller {}\n"
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("Web/Controller.cs -> Service/UserService.cs");
  });

  it("C#: resolves static calls through a single namespace-resolved class file", () => {
    const root = repo({
      "Service/UserService.cs": "namespace App.Service;\nclass UserService { static void Load() {} }\n",
      "Web/Controller.cs": "using App.Service;\nnamespace App.Web;\nclass Controller { void Show() { UserService.Load(); } }\n"
    });
    expect(edgeStrings(root, "CALLS")).toContain("sym:Web/Controller.cs#Show -> sym:Service/UserService.cs#Load");
  });

  it("C#: resolves class calls inside a multi-file namespace without emitting a file import", () => {
    const root = repo({
      "Service/UserService.cs": "namespace App.Service;\nclass UserService { static void Load() {} }\n",
      "Service/TeamService.cs": "namespace App.Service;\nclass TeamService { static void Load() {} }\n",
      "Web/Controller.cs": "using App.Service;\nnamespace App.Web;\nclass Controller { void Show() { UserService.Load(); } }\n"
    });
    expect(edgeStrings(root, "IMPORTS")).toEqual([]);
    expect(edgeStrings(root, "CALLS")).toContain("sym:Web/Controller.cs#Show -> sym:Service/UserService.cs#Load");
  });

  it("C#: resolves same-namespace class calls without a using directive", () => {
    const root = repo({
      "Main/Helper.cs": "namespace App.Main;\nclass Helper { static void Go() {} }\n",
      "Main/Caller.cs": "namespace App.Main;\nclass Caller { void X() { Helper.Go(); } }\n"
    });
    expect(edgeStrings(root, "CALLS")).toContain("sym:Main/Caller.cs#X -> sym:Main/Helper.cs#Go");
  });

  it("C#: same-simple-name classes in own and imported namespaces underlink instead of misresolving", () => {
    const root = repo({
      "Main/Helper.cs": "namespace App.Main;\nclass Helper { static void Go() {} }\n",
      "Other/Helper.cs": "namespace App.Other;\nclass Helper { static void Go() {} }\n",
      "Main/Caller.cs": "using App.Other;\nnamespace App.Main;\nclass Caller { void X() { Helper.Go(); } }\n"
    });
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("C#: duplicate class FQNs underlink instead of guessing", () => {
    const root = repo({
      "A/UserService.cs": "namespace App.Service;\nclass UserService { static void Load() {} }\n",
      "B/UserService.cs": "namespace App.Service;\nclass UserService { static void Load() {} }\n",
      "Web/Controller.cs": "using App.Service;\nnamespace App.Web;\nclass Controller { void Show() { UserService.Load(); } }\n"
    });
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("C#: test files are TestCase nodes, not product structural call sources", () => {
    const root = repo({
      "src/Product/UserService.cs": "namespace App.Service;\nclass UserService { static void Load() {} }\n",
      "src/UnitTests/UserServiceTests.cs":
        "using App.Service;\nnamespace App.Tests;\nclass UserServiceTests { void CallsLoad() { UserService.Load(); } }\n"
    });
    const fragment = analyzeRepo(root, { readContent: true });
    const ids = new Set(fragment.nodes.map((n) => n.external_id));

    expect(ids).toContain("test:src/UnitTests/UserServiceTests.cs");
    expect(ids).not.toContain("sym:src/UnitTests/UserServiceTests.cs#CallsLoad");
    expect(fragment.edges.filter((e) => e.relationship_type === "CALLS")).toEqual([]);
  });

  it("C#: local bindings shadow namespace-resolved class calls", () => {
    const root = repo({
      "Service/UserService.cs": "namespace App.Service;\nclass UserService { static void Load() {} }\n",
      "Web/Controller.cs": "using App.Service;\nnamespace App.Web;\nclass Controller { void Show(UserService UserService) { UserService.Load(); } }\n"
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("Web/Controller.cs -> Service/UserService.cs");
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("C#: catch and foreach variables shadow namespace-resolved class calls", () => {
    const root = repo({
      "Service/UserService.cs":
        "namespace App.Service;\nclass UserService : System.Exception { public void Load() {} }\n",
      "Web/Controller.cs": [
        "using App.Service;",
        "namespace App.Web;",
        "class Controller {",
        "  void Caught() { try {} catch (UserService UserService) { UserService.Load(); } }",
        "  void Loop(System.Collections.Generic.List<UserService> xs) { foreach (var UserService in xs) { UserService.Load(); } }",
        "}"
      ].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("Web/Controller.cs -> Service/UserService.cs");
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("C#: out variables and lambda parameters shadow namespace-resolved class calls", () => {
    const root = repo({
      "Service/Helper.cs": "namespace App.Service;\nclass Helper { public void C() {} }\n",
      "Web/Controller.cs": [
        "using App.Service;",
        "namespace App.Web;",
        "class Controller {",
        "  void R(dynamic Factory, dynamic xs) {",
        "    if (Factory.Try(out var Helper)) { Helper.C(); }",
        "    xs.Select(Helper => Helper.C());",
        "    xs.Select((Helper) => Helper.C());",
        "    xs.Select((Helper Helper) => Helper.C());",
        "  }",
        "}"
      ].join("\n")
    });
    expect(edgeStrings(root, "IMPORTS")).toContain("Web/Controller.cs -> Service/Helper.cs");
    expect(edgeStrings(root, "CALLS")).toEqual([]);
  });

  it("C#: ambiguous namespaces underlink instead of guessing", () => {
    const root = repo({
      "Service/UserService.cs": "namespace App.Service;\nclass UserService {}\n",
      "Service/TeamService.cs": "namespace App.Service;\nclass TeamService {}\n",
      "Web/Controller.cs": "using App.Service;\nnamespace App.Web;\nclass Controller {}\n"
    });
    expect(edgeStrings(root, "IMPORTS")).toEqual([]);
  });

  it("C/C++: resolves quoted relative includes only when the target file exists", () => {
    const root = repo({
      "c/service.h": "struct Service { int id; };\n",
      "c/controller.c": "#include \"service.h\"\nvoid show() {}\n",
      "cpp/service.hpp": "struct Service { int id; };\n",
      "cpp/controller.cpp": "#include \"service.hpp\"\nvoid show() {}\n"
    });
    expect(edgeStrings(root, "IMPORTS")).toEqual([
      "c/controller.c -> c/service.h",
      "cpp/controller.cpp -> cpp/service.hpp"
    ]);
  });

  it("Swift: module imports are not mapped to files without package/module knowledge", () => {
    const root = repo({
      "Sources/App/UserService.swift": "class UserService {}\n",
      "Sources/App/Controller.swift": "import Foundation\nclass Controller {}\n"
    });
    expect(edgeStrings(root, "IMPORTS")).toEqual([]);
  });
});
