import { describe, it, expect } from "vitest";
import { extractSymbolsWithMeta, listFunctionSites, type ExtractedSymbol } from "../../src/local/analyze/symbols.js";
import { describeTarget } from "../../src/local/contracts/targetRecord.js";

const extract = (src: string) => extractSymbolsWithMeta(src, "javascript");
const names = (src: string): string[] => extract(src).symbols.map((s) => s.name).sort();
const sym = (src: string, name: string): ExtractedSymbol | undefined => extract(src).symbols.find((s) => s.name === name);
const codes = (src: string): string[] => (extract(src).not_supported ?? []).map((e) => e.code).sort();

describe("way 1 — export list", () => {
  it("records the local name and keeps a differing exported name as an alias", () => {
    const src = "function load(id) { return fetchOne(id); }\nconst save = async (row) => { await write(row); };\nexport { load, save as persist };\n";
    expect(names(src)).toEqual(["load", "save"]);
    expect(sym(src, "load")).toMatchObject({ symbol_kind: "function", seen_by: "export_list", start_line: 1 });
    expect(sym(src, "save")).toMatchObject({ symbol_kind: "const", callable: true, aliases: ["persist"] });
  });
  it("a class brings its public methods; `as default` is an alias", () => {
    const src = "class Ledger {\n  post(entry) { return this.rows.push(entry); }\n  #seal() {}\n}\nfunction open() { return new Ledger(); }\nexport { Ledger, open as default };\n";
    expect(names(src)).toEqual(["Ledger", "Ledger.post", "open"]);
    expect(sym(src, "Ledger.post")).toMatchObject({ symbol_kind: "method", member_of: "Ledger", seen_by: "export_list" });
    expect(sym(src, "open")?.aliases).toEqual(["default"]);
  });
  it("skips type-only exports, ambient declarations and non-functions", () => {
    expect(names("class Shape { area() { return 1; } }\nexport type { Shape };\n")).toEqual([]);
    expect(names("class Shape { area() { return 1; } }\nexport { type Shape };\n")).toEqual([]);
    expect(names("declare function probe(): void;\nexport { probe };\n")).toEqual([]);
    expect(names("const limit = 3;\nexport { limit };\n")).toEqual([]);
  });
  it("a name a declaration rule already emits keeps that record and only gains the alias", () => {
    const src = "export function load() { return 1; }\nexport { load as fetchAll };\n";
    expect(names(src)).toEqual(["load"]);
    expect(sym(src, "load")).toMatchObject({ symbol_kind: "function", aliases: ["fetchAll"] });
    expect(sym(src, "load")?.seen_by).toBeUndefined();
  });
});

describe("way 2 — prototype method", () => {
  const owner = "function Stack() { this.items = []; }\nmodule.exports = Stack;\n";
  it("records `F.name` when F is exported", () => {
    const src = `${owner}Stack.prototype.push = function push(item) { this.items.push(item); return this.size(); };\nStack.prototype.size = function () { return this.items.length; };\n`;
    expect(names(src)).toEqual(["Stack", "Stack.push", "Stack.size"]);
    expect(sym(src, "Stack.push")).toMatchObject({ symbol_kind: "method", member_of: "Stack", seen_by: "prototype_method", shape_form: "prototype", start_line: 3, end_line: 3 });
  });
  it("two names on one function are one symbol with an alias", () => {
    const src = `${owner}Stack.prototype.peek = Stack.prototype.top = function top() { return this.items[this.items.length - 1]; };\n`;
    expect(names(src)).toEqual(["Stack", "Stack.top"]);
    expect(sym(src, "Stack.top")?.aliases).toEqual(["Stack.peek"]);
  });
  it("withholds a name that has more than one definition", () => {
    expect(names(`${owner}Stack.prototype.pop = function () { return 1; };\nStack.prototype.pop = function () { return 2; };\n`)).toEqual(["Stack"]);
    expect(codes(`${owner}Stack.prototype.pop = function () { return 1; };\nStack.prototype.pop = function () { return 2; };\n`)).toEqual(["duplicate_member", "duplicate_member"]);
    expect(names(`${owner}Stack.prototype.pop = function () { return 1; };\nStack.prototype = {};\n`)).toEqual(["Stack"]);
    // A class method of the same name: the existing symbol stays, nothing new is added.
    const cls = "export class Queue { take() { return 1; } }\nQueue.prototype.take = function () { return 2; };\n";
    expect(names(cls)).toEqual(["Queue", "Queue.take"]);
    expect(sym(cls, "Queue.take")).toMatchObject({ start_line: 1 });
    expect(sym(cls, "Queue.take")?.seen_by).toBeUndefined();
  });
  it("an owner the extractor does not see yields nothing; it is reported only when it is exported", () => {
    const exported = "var Stack = function () {};\nStack.prototype.push = function (x) { return x; };\nmodule.exports = Stack;\n";
    expect(names(exported)).toEqual([]);
    expect(codes(exported)).toEqual(["owner_not_seen"]);
    const privateOwner = "function Node() {}\nNode.prototype.link = function (n) { this.next = n; };\nexports.make = function () { return new Node(); };\n";
    expect(names(privateOwner)).toEqual(["make"]);
    expect(codes(privateOwner)).toEqual([]);
  });
  it("a prototype set as one object is reported, not guessed", () => {
    expect(codes(`${owner}Stack.prototype = { push: function (x) { return x; } };\n`)).toEqual(["prototype_object"]);
    expect(codes(`${owner}Object.assign(Stack.prototype, { push(x) { return x; } });\n`)).toEqual(["prototype_object"]);
  });
});

describe("way 3 — exported-object method", () => {
  it("records members of an Object.create owner, named or not", () => {
    const src = "var base = require('./base');\nvar api = Object.create(base.prototype);\nmodule.exports = api;\napi.fetch = function (id) { return this.store.read(id); };\napi.remove = function remove(id) { return this.store.drop(id); };\n";
    expect(names(src)).toEqual(["api.fetch", "api.remove"]);
    expect(sym(src, "api.fetch")).toMatchObject({ symbol_kind: "method", member_of: "api", seen_by: "exported_object_method", shape_form: "member" });
  });
  it("accepts the chained literal owner and the two-name rule", () => {
    const src = "var kit = exports = module.exports = {};\nkit.set = kit.header = function header(k, v) { this.map[k] = v; return this; };\nkit.open = function open() { return this.header('x', 1); };\n";
    expect(names(src)).toEqual(["kit.header", "kit.open"]);
    expect(sym(src, "kit.header")?.aliases).toEqual(["kit.set"]);
  });
  it("withholds a member written more than once, through any alias", () => {
    const src = "var kit = exports = module.exports = {};\nkit.run = function () { return 1; };\nexports.run = function () { return 2; };\nkit.stop = function () { return 3; };\n";
    expect(names(src)).toEqual(["kit.stop", "run"]); // `exports.run = function` keeps today's bare name
    expect(codes(src)).toEqual(["duplicate_member"]);
    const open = "var kit = module.exports = {};\nkit.run = function () { return 1; };\nObject.assign(kit, extras);\n";
    expect(names(open)).toEqual([]);
  });
  it("a run-time key does not withhold the named members; it is reported", () => {
    const src = "var kit = module.exports = {};\nkit.run = function () { return 1; };\n['a', 'b'].forEach(function (verb) {\n  kit[verb] = function () { return verb; };\n});\n";
    expect(names(src)).toEqual(["kit.run"]);
    expect(codes(src)).toEqual(["computed_or_nested"]);
  });
  it("reports helper-defined members, unjudgeable owners and ambiguous owners", () => {
    const helper = "var kit = module.exports = {};\nfunction define(obj, name, getter) { Object.defineProperty(obj, name, { get: getter }); }\ndefine(kit, 'size', function size() { return 1; });\n";
    expect(names(helper)).toEqual([]);
    expect(extract(helper).not_supported).toEqual([{ code: "helper_defined", owner: "kit", name: "size", start_line: 3, end_line: 3 }]);
    expect(codes("var kit = makeKit();\nmodule.exports = kit;\nkit.run = function () { return 1; };\n")).toEqual(["owner_kind"]);
    expect(codes("var kit = module.exports = makeKit();\nkit.run = function () { return 1; };\n")).toEqual(["owner_kind"]);
    // A function attached to an exported function or component, in either module style.
    expect(codes("module.exports = make;\nfunction make() { return 1; }\nmake.all = function () { return []; };\n")).toEqual(["owner_kind"]);
    expect(codes("export function Card() { return null; }\nCard.Header = () => null;\n")).toEqual(["owner_kind"]);
    // …but not one attached to something the file keeps to itself.
    expect(codes("function inner() { return 1; }\ninner.cache = function () { return {}; };\nexport function outer() { return inner(); }\n")).toEqual([]);
    expect(codes("var a = {};\nvar b = {};\na.run = function () { return 1; };\nmodule.exports = a;\nif (process.env.ALT) module.exports = b;\n")).toEqual(["ambiguous_owner"]);
  });
  it("leaves today's shapes exactly as they are", () => {
    expect(names("exports.header = exports.set = function header() { return 1; };\n")).toEqual(["set"]);
    expect(names("var exports = module.exports = {};\nexports.run = function () { return 1; };\n")).toEqual(["run"]);
    expect(names("exports.parse = function () { return 1; };\nif (process.env.ALT) { exports.parse = function () { return 2; }; }\n")).toEqual(["parse"]);
    const twice = "exports.x = function () { return 1; };\nexports.x = wrap(exports.x);\n";
    expect(sym(twice, "x")).toMatchObject({ symbol_kind: "function", start_line: 1 });
    expect(names("var store = {};\nstore.read = function () { return 1; };\n")).toEqual([]);
    expect(names("var f = function () { return 1; };\nmodule.exports = f;\n")).toEqual([]);
  });
});

describe("way 4 — object-literal export", () => {
  it("records inline functions under their key and references under their local name", () => {
    const src = [
      "function loadAll(q) { return db.find(q); }",
      "const removeOne = async (id) => { await db.drop(id); };",
      "class Cache { warm() { return 1; } }",
      "module.exports = {",
      "  loadAll,",
      "  erase: removeOne,",
      "  Cache,",
      "  count(q) { return db.count(q); },",
      "  first: function (q) { return db.find(q)[0]; },",
      "  last: (q) => { return db.find(q).pop(); },",
      "  port: 3000",
      "};",
      ""
    ].join("\n");
    expect(names(src)).toEqual(["Cache", "Cache.warm", "count", "first", "last", "loadAll", "removeOne"]);
    expect(sym(src, "count")).toMatchObject({ symbol_kind: "function", seen_by: "object_literal_export", shape_form: "literal_inline" });
    expect(sym(src, "removeOne")).toMatchObject({ shape_form: "literal_reference", aliases: ["erase"] });
    expect(sym(src, "loadAll")).toMatchObject({ start_line: 1, end_line: 1 });
  });
  it("a config object still yields nothing", () => {
    expect(names("module.exports = { port: 3000, name: 'x' };\n")).toEqual([]);
  });
  it("reports accessors, spreads, computed keys and name collisions instead of guessing", () => {
    expect(codes("module.exports = { get size() { return 1; }, run() { return 2; } };\n")).toEqual(["accessor"]);
    const spread = "module.exports = { early() { return 1; }, ...others, late() { return 2; } };\n";
    expect(names(spread)).toEqual(["late"]); // a spread can replace what was written before it
    expect(codes(spread)).toEqual(["spread"]);
    expect(codes("module.exports = { ['a' + 'b']: function () { return 1; }, 'x-y': function () { return 2; } };\n")).toEqual(["computed_or_nested", "computed_or_nested"]);
    const collision = "const { list } = require('./db');\nmodule.exports = { list(q) { return list(q); }, first(q) { return list(q)[0]; } };\n";
    expect(names(collision)).toEqual(["first"]);
    expect(codes(collision)).toEqual(["name_collision"]);
  });
  it("a key defined twice, or written again later, adds nothing new", () => {
    expect(names("module.exports = { run() { return 1; }, run: function () { return 2; } };\n")).toEqual([]);
    const later = "function a() { return 1; }\nmodule.exports = { a };\nmodule.exports.a = a;\n";
    expect(names(later)).toEqual(["a"]);
    expect(sym(later, "a")?.seen_by).toBeUndefined(); // today's rule still owns it
    expect(codes(later)).toEqual(["duplicate_member"]);
  });
});

describe("way 5 — unnamed default export", () => {
  it("records `default` for every unnamed function form", () => {
    for (const src of [
      "export default function () { return 1; }\n",
      "export default async function () { return 1; }\n",
      "export default function* () { yield 1; }\n",
      "export default (function () { return 1; });\n",
      "export default () => 1;\n",
      "export default async (id) => { return id; };\n"
    ]) {
      expect(names(src)).toEqual(["default"]);
      expect(sym(src, "default")).toMatchObject({ symbol_kind: "function", seen_by: "unnamed_default_export", shape_form: "unnamed_default" });
    }
  });
  it("an unnamed default class and the CommonJS twin are not recorded; the twin is reported", () => {
    expect(names("export default class { run() { return 1; } }\n")).toEqual([]);
    expect(names("module.exports = function () { return 1; };\n")).toEqual([]);
    expect(codes("module.exports = function () { return 1; };\n")).toEqual(["unnamed_export"]);
    expect(codes("module.exports = () => 1;\n")).toEqual(["unnamed_export"]);
  });
});

describe("review findings — shapes that must not become symbols", () => {
  it("an owner re-bound in a way a plain assignment check misses yields no members", () => {
    const member = "kit.run = function () { return compute(1); };\nmodule.exports = kit;\n";
    for (const rebinding of [
      "[kit] = [other];",
      "({ kit } = holder);",
      "for (kit of items) { use(kit); }",
      "if (flag) { var kit = other; }"
    ]) {
      expect(names(`var kit = {};\n${rebinding}\n${member}`), rebinding).toEqual([]);
    }
    // A member that is deleted again is not defined once.
    expect(names("var kit = module.exports = {};\nkit.run = function () { return compute(1); };\ndelete kit.run;\n")).toEqual([]);
    // A second write to `module.exports` in another spelling leaves no single exported object.
    expect(names("var kit = module.exports = {};\nkit.run = function () { return compute(1); };\nmodule['exports'] = other;\n")).toEqual([]);
    expect(names("var kit = module.exports = {};\nkit.run = function () { return compute(1); };\nmodule.exports ||= other;\n")).toEqual([]);
  });
  it("a prototype owner must be the file's own function, not just a symbol of that name", () => {
    const src = "var Emitter = require('events');\nexports.Emitter = function () { return 1; };\nEmitter.prototype.ping = function () { return this.emit('ping'); };\n";
    expect(names(src)).toEqual(["Emitter"]); // the export key only; `Emitter.prototype` patches the imported class
  });
  it("`__proto__` in an exported literal sets the prototype; it is not a property", () => {
    expect(names("module.exports = { __proto__: function () { return 1; }, run() { return compute(2); } };\n")).toEqual(["run"]);
  });
  it("a class member with a computed literal name counts as a definition of that name", () => {
    const src = "export class Queue { ['take']() { return 1; } }\nQueue.prototype.take = function () { return 2; };\n";
    expect(names(src)).toEqual(["Queue"]);
    expect(codes(src)).toEqual(["duplicate_member"]);
  });
  it("records whether a referenced function is exported under its own name, and whether a name is only an export key", () => {
    const list = "function parse(a) { return JSON.parse(a); }\nfunction parseLoose(a) { try { return JSON.parse(a); } catch (e) { return null; } }\nexport { parseLoose as parse, parse as parseStrict };\n";
    expect(sym(list, "parse")).toMatchObject({ aliases: ["parseStrict"], own_name_exported: false });
    expect(sym(list, "parseLoose")).toMatchObject({ aliases: ["parse"], own_name_exported: false });
    expect(sym("function a() { return 1; }\nexport { a, a as b };\n", "a")?.own_name_exported).toBeUndefined();
    expect(sym("exports.send = function () { return 1; };\n", "send")?.unbound_name).toBe(true);
    expect(sym("function send() { return 1; }\nexports.send = send;\n", "send")?.unbound_name).toBeUndefined();
  });
});

describe("the two grammar passes", () => {
  it("positions and body judgements come from the pass that parsed, never from the one that failed", () => {
    // Plain TypeScript cannot parse this JSX and runs `Card` on to the end of the file; TSX parses it.
    const src = "export function Card(p) {\n  return <p>{p.ok && <b>it's fine</b>}</p>;\n}\n\nfunction priceWithTax(amount) {\n  return amount * 1.2;\n}\n\nexport function total(items) {\n  return items.reduce((sum, i) => sum + priceWithTax(i), 0);\n}\n";
    const lineOf = (offset: number): number => src.slice(0, offset).split("\n").length;
    const card = listFunctionSites(src).sites.find((s) => s.name === "Card");
    expect([lineOf(card!.fn![0]), lineOf(card!.fn![1] - 1)]).toEqual([1, 3]);
    // The symbol's reported lines stay exactly as 0.2.58 has them.
    expect(extractSymbolsWithMeta(src, "javascript").symbols.find((s) => s.name === "Card")).toMatchObject({ start_line: 1, end_line: 11 });
    // Neither pass parses a bare `>` in JSX text: no position is claimed at all.
    const broken = "export function A() {\n  return <p>a / b > c => d</p>;\n}\n";
    expect(listFunctionSites(broken).sites.find((s) => s.name === "A")).toBeUndefined();
    expect(names(broken)).toEqual(["A"]);
  });
  it("uses the clean pass when the other cannot parse the file", () => {
    // A generic arrow parses as TypeScript and not as TSX.
    const src = "const pick = <T>(xs: T[]): T => xs[0];\nfunction head(xs: number[]) { return pick(xs); }\nexport { head };\n";
    expect(extractSymbolsWithMeta(src, "typescript").symbols.map((s) => s.name)).toEqual(["head"]);
  });
});

describe("traits — documented private", () => {
  const priv = (doc: string): boolean => sym(`var kit = module.exports = {};\n${doc}kit.run = function run() { return compute(1); };\n`, "kit.run")?.documented_private === true;
  it("reads the last JSDoc block before the statement, across a blank line", () => {
    expect(priv("/**\n * Run.\n * @private\n */\n\n")).toBe(true);
    expect(priv("/** @internal */\n")).toBe(true);
    expect(priv("/**\n * @api private\n */\n")).toBe(true);
    expect(priv("/**\n * @access private\n */\n")).toBe(true);
  });
  it("reads a JSDoc block that sits on the previous token's line", () => {
    const literal = "module.exports = { /** @private */ sweep() { return compute(1); }, /** @internal */ tidy: function () { return compute(2); }, run() { return compute(3); } };\n";
    expect(sym(literal, "sweep")?.documented_private).toBe(true);
    expect(sym(literal, "tidy")?.documented_private).toBe(true);
    expect(sym(literal, "run")?.documented_private).toBeUndefined();
  });
  it("ignores look-alikes", () => {
    expect(priv("/**\n * @privateRemarks kept for callers\n */\n")).toBe(false);
    expect(priv("/**\n * Not marked @private in running text.\n */\n")).toBe(false);
    expect(priv("// @private\n")).toBe(false);
    expect(priv("/* @private */\n")).toBe(false);
    // An earlier section comment does not reach past another statement or another JSDoc block.
    expect(priv("/**\n * Module variables.\n * @private\n */\nvar cache = {};\n\n")).toBe(false);
    expect(priv("/**\n * @private\n */\n\n/**\n * Run.\n * @public\n */\n")).toBe(false);
  });
});

describe("traits — trivial bodies", () => {
  const member = (body: string, params = "value"): ExtractedSymbol | undefined =>
    sym(`var kit = module.exports = {};\nkit.target = function (${params}) ${body};\nkit.other = function (a) { return compute(a); };\n`, "kit.target");
  it("empty, returns a stored value, stores a parameter", () => {
    expect(member("{}")?.trivial_body).toBe("empty");
    expect(member("{ return this.name; }")?.trivial_body).toBe("stored_value");
    expect(member("{ return (this.settings.depth); }")?.trivial_body).toBe("stored_value");
    expect(member("{ this.name = value; }")?.trivial_body).toBe("stores_parameter");
    expect(member("{ this.name = value; return this; }")?.trivial_body).toBe("stores_parameter");
  });
  it("anything that computes, compares, decides or adds a fixed value is not trivial", () => {
    for (const body of [
      "{ return this.count + 1; }",
      "{ return value === this.role; }",
      "{ return this.items[value]; }",
      "{ this.name = String(value); }",
      "{ this.name = value; return true; }",
      "{ if (value) return this.name; }",
      "{ return this.set(value, true); }",
      "{ this.store.drop(value); }",
      "{ return this.other(value, value); }",
      "{ return this.other(); }"
    ]) {
      const s = member(body);
      expect(s?.trivial_body, body).toBeUndefined();
      expect(s?.pass_through, body).toBeUndefined();
    }
    expect(member("{ return this.name; }", "value = 1")?.trivial_body).toBeUndefined();
    expect(member("{}", "value = 1")?.trivial_body).toBe("empty"); // nothing to observe, whatever the parameters
  });
  it("a generator is never trivial: calling it runs none of its body", () => {
    expect(sym("function rows(q) { return [q]; }\nfunction* each(q) { return rows(q); }\nexport { each, rows };\n", "each")?.pass_through).toBeUndefined();
    expect(sym("function* none() {}\nexport { none };\n", "none")?.trivial_body).toBeUndefined();
  });
  it("marks a straight pass-through as a candidate only", () => {
    expect(member("{ return this.other(value); }")).toMatchObject({ pass_through: { via: "this", callee: "other" } });
    const free = "function compute(a, b) { return a * b; }\nexport const area = (a, b) => compute(a, b);\nexport const swapped = (a, b) => compute(b, a);\nexport const outside = (a) => external(a);\n";
    expect(sym(free, "area")).toMatchObject({ pass_through: { via: "free", callee: "compute" } });
    expect(sym(free, "swapped")?.pass_through).toBeUndefined();
    expect(sym(free, "outside")?.pass_through).toBeUndefined(); // not a function of this file
  });
});

describe("definition spans", () => {
  it("binds a member to its statement, function and body by raw bytes", () => {
    const src = "var kit = module.exports = {};\n// é — non-ASCII before the target\r\nkit.set = kit.header = function header(k, v) {\n  return k + v;\n};\n";
    const site = listFunctionSites(src).sites.find((s) => s.name === "kit.header");
    expect(site).toMatchObject({ shape_form: "member", fn_kind: "expression", targets: ["kit.set", "kit.header"], owner_binding: "object_literal" });
    const described = describeTarget(Buffer.from(src, "utf8"), "kit.header");
    expect(described.ok).toBe(true);
    if (!described.ok) return;
    const bytes = Buffer.from(src, "utf8");
    const t = described.target;
    expect(bytes.subarray(t.function.bytes.start, t.function.bytes.end).toString("utf8")).toBe("function header(k, v) {\n  return k + v;\n}");
    expect(bytes.subarray(t.body!.bytes.start, t.body!.bytes.end).toString("utf8")).toBe("{\n  return k + v;\n}");
    expect(bytes.subarray(t.statement.bytes.start, t.function.bytes.start).toString("utf8")).toBe("kit.set = kit.header = ");
    expect(t.function.lines).toEqual({ start: 3, end: 5 });
    expect(t.mutation_route).toBe("bound");
  });
  it("an overloaded function is bound to the declaration that has the body", () => {
    const src = "export function pick(a: string): string;\nexport function pick(a: number): number;\nexport function pick(a: any) {\n  return a;\n}\n";
    const site = listFunctionSites(src).sites.find((s) => s.name === "pick");
    expect(src.slice(site!.fn![0], site!.fn![1])).toBe("export function pick(a: any) {\n  return a;\n}");
    expect(site?.start_line).toBe(1); // the symbol's reported lines stay as 0.2.58 has them
  });
  it("routes each shape to the mutator that can find it", () => {
    const route = (src: string, name: string) => {
      const d = describeTarget(Buffer.from(src, "utf8"), name);
      return d.ok ? d.target.mutation_route : d.refused;
    };
    const literal = "module.exports = { run(a) { return a; }, stop: function (a) { return a; }, wait: (a) => { return a; } };\n";
    expect(route(literal, "run")).toBe("name_search");
    expect(route(literal, "stop")).toBe("unsupported_shape");
    expect(route(literal, "wait")).toBe("unsupported_shape");
    expect(route("export default function () { return 1; }\n", "default")).toBe("unsupported_shape");
    expect(route("export function plain() { return 1; }\n", "plain")).toBe("name_search");
    expect(route("function F() {}\nmodule.exports = F;\nF.prototype.go = function () { return 1; };\n", "F.go")).toBe("bound");
    expect(route("export function plain() { return 1; }\n", "missing")).toBe("symbol_not_found");
  });
  it("refuses a file whose line breaks git and the parser count differently", () => {
    const src = `var kit = module.exports = {};\nvar note = "a${String.fromCharCode(0x2028)}b";\nkit.run = function () { return 1; };\n`;
    expect(describeTarget(Buffer.from(src, "utf8"), "kit.run")).toEqual({ ok: false, refused: "line_rule_mismatch" });
    expect(describeTarget(Buffer.from([0x76, 0x61, 0x72, 0x20, 0xff, 0xfe]), "kit.run")).toEqual({ ok: false, refused: "not_utf8" });
  });
});
