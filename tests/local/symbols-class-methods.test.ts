import { describe, it, expect } from "vitest";
import { extractSymbolsWithMeta } from "../../src/local/analyze/symbols.js";

const syms = (src: string) => extractSymbolsWithMeta(src, "typescript").symbols;
const names = (src: string) => syms(src).map((s) => s.name).sort();
const find = (src: string, name: string) => syms(src).find((s) => s.name === name);

describe("collectTsJsExports — class members (Finding 2)", () => {
  it("extracts methods of an exported class as qualified `Class.method` members", () => {
    const src = "export class AdminAboutAPI {\n  about() { return 1; }\n  statistics() { return 2; }\n}\n";
    const got = names(src);
    expect(got).toContain("AdminAboutAPI"); // the class itself
    expect(got).toContain("AdminAboutAPI.about");
    expect(got).toContain("AdminAboutAPI.statistics");
    const m = find(src, "AdminAboutAPI.about")!;
    expect(m.symbol_kind).toBe("method");
    expect(m.member_of).toBe("AdminAboutAPI");
  });

  it("excludes the constructor and get/set accessors (only real methods)", () => {
    const src = "export class C {\n  constructor() {}\n  get x() { return 1; }\n  set x(v) {}\n  doWork() { return 2; }\n}\n";
    const got = names(src);
    expect(got).toContain("C.doWork");
    expect(got).not.toContain("C.constructor");
    expect(got).not.toContain("C.x"); // accessors are not methods
  });

  it("qualifies names so same-named methods on different classes never collide", () => {
    const src = "export class A { run() {} }\nexport class B { run() {} }\n";
    const got = names(src);
    expect(got).toContain("A.run");
    expect(got).toContain("B.run");
  });

  it("does NOT extract members of a non-exported, non-default class (export-only)", () => {
    expect(names("class Internal { m() {} }\n")).toEqual([]);
  });

  it("extracts members of a default-exported class (both forms)", () => {
    expect(names("class Widget { render() {} }\nexport default Widget;\n")).toEqual(["Widget", "Widget.render"]);
    expect(names("export default class Panel { render() {} }\n")).toContain("Panel.render");
  });

  it("does not duplicate members across the TS/TSX grammar passes", () => {
    const got = names("export class S { a() {} }\n");
    expect(got.filter((n) => n === "S.a")).toHaveLength(1);
  });

  it("counts only the PUBLIC surface — private/protected/#private are skipped (Codex #60)", () => {
    const src = "export class Api {\n  public about() {}\n  private parse() {}\n  protected build() {}\n  static make() {}\n  #secret() {}\n}\n";
    const got = names(src);
    expect(got).toContain("Api.about"); // public
    expect(got).toContain("Api.make"); // public static
    expect(got).not.toContain("Api.parse"); // private
    expect(got).not.toContain("Api.build"); // protected
    expect(got).not.toContain("Api.#secret"); // JS #private
  });

  it("treats an unmodified method as public (default visibility)", () => {
    expect(names("export class C { run() {} }\n")).toContain("C.run");
  });

  it("requires a runtime body — abstract and ambient members are not behavior (Codex #60)", () => {
    const abstractSrc = "export abstract class Service {\n  abstract load(): Promise<void>;\n  concrete() {}\n}\n";
    const got = names(abstractSrc);
    expect(got).toContain("Service.concrete"); // has a body
    expect(got).not.toContain("Service.load"); // abstract — no body

    const ambientSrc = "export declare class AmbientService {\n  fetch(): Promise<void>;\n}\n";
    expect(names(ambientSrc)).not.toContain("AmbientService.fetch"); // declare class — no impl
  });

  it("records only the overload IMPLEMENTATION, not the signatures", () => {
    const src = "export class P {\n  do(a: string): void;\n  do(a: number): void;\n  do(a: unknown) {}\n}\n";
    const got = names(src);
    expect(got.filter((n) => n === "P.do")).toHaveLength(1); // the impl, once
  });

  it("does not emit the ambient `declare class` NODE itself (Codex #60 follow-up)", () => {
    const got = names("export declare class Ambient {\n  fetch(): Promise<void>;\n}\n");
    expect(got).not.toContain("Ambient"); // the class node is ambient — no runtime impl
    expect(got).toEqual([]);
  });

  it("a concrete class beside a declare class is still emitted", () => {
    const src = "export declare class Amb { f(): void; }\nexport class Real { run() {} }\n";
    const got = names(src);
    expect(got).not.toContain("Amb");
    expect(got).toContain("Real");
    expect(got).toContain("Real.run");
  });
});
