import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Nested object property: the singleton sits at ctx.inner.service (TWO levels deep).
// Reflect.set's receiver is `ctx.inner.service` -> bindingFromNestInstanceExpr ->
// bindingFromObjectProperty(owner=`ctx.inner`, "service"). The owner is a
// PropertyAccessExpression, not an identifier/object-literal, so bindingFromObjectProperty
// returns null (~1115). Single-level `bag.ref` would be caught (R7F-objprop) but the
// nested owner escapes. The real method is overwritten; `service.<method>` proves clean.
it("R9F-nested-objprop-reflectset: nested object property escapes reflective poison (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const ctx = { inner: { service } };
  Reflect.set(ctx.inner.service, "uploadDefaultPackageFilesAndSetFileIds", async () => false);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
