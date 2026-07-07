import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Map built from Object.entries(...) rather than an array literal. recordMapEntryBindings
// (~1376) requires `new Map([ [k,v], ... ])` with an ARRAY-LITERAL first argument; here the
// arg is a CallExpression (Object.entries(...)), so the registration returns early and `m` has
// NO map-entry binding. Reflect.set's receiver `m.get("svc")` -> bindingFromMapGet ->
// mapEntryBindings.get(m) -> unset -> null. The `.set()` form (R7F-mapget) and array-literal
// constructor (R8F-map-constructor-entry) are both caught; the Object.entries constructor
// escapes. m.get("svc") === service at runtime, so the real method is overwritten.
it("R9F-mapfromentries-reflectset: Map(Object.entries) escapes reflective poison (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const m = new Map<string, any>(Object.entries({ svc: service }));
  Reflect.set(m.get("svc"), "uploadDefaultPackageFilesAndSetFileIds", async () => false);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
