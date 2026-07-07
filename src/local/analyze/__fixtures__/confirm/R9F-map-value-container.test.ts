import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Map whose VALUE is a container object, not the instance directly. recordMapEntryBindings
// only stores an entry when bindingFromNestInstanceExpr(value) resolves; the value
// `{ svc: service }` is an object literal -> null, so key "k" is never registered. The
// mutation receiver `reg.get("k").svc` is a PropertyAccess `.svc` whose OWNER is the
// `.get("k")` CallExpression; bindingFromObjectProperty handles only identifier/object-literal
// owners (it never recurses a call owner back through bindingFromMapGet), so it returns null
// -> NO poison. At runtime reg.get("k").svc === service, real body dead, direct call proves.
// (R8F-map-constructor-entry / R7F-mapget store the instance directly and ARE poisoned.)
it("R9F-map-value-container: map-of-container launder still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const reg = new Map<string, any>([["k", { svc: service }]]);
  reg.get("k").svc.uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
