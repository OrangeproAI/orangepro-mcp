import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Re-stash a registered container under a named property of another container. `inner` IS a
// registered objectPropertyBindings container, but `outer = { mid: inner }` registers `mid`
// only if bindingFromNestInstanceExpr(inner) resolves -- and that only checks instanceBindings
// (leaf instances), never objectPropertyBindings (containers), so it returns null and `mid`
// is never entered. objectPropertyBindings values are leaf NestInstanceBindings; they cannot
// encode "this property holds another container". The mutation receiver `outer.mid.svc` has a
// PropertyAccess owner `outer.mid` -> bindingFromObjectProperty null -> NO poison. (A spread
// `{ ...inner }` WOULD copy the bindings and be caught; the named alias is the gap.) At runtime
// outer.mid.svc === service, real body dead, direct call + expect() confirm.
it("R9F-container-restash-alias: aliased nested container launder still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const inner = { svc: service };
  const outer = { mid: inner };
  outer.mid.svc.uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
