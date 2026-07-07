import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Two-level object-literal container. recordObjectPropertyBindings only stores a
// property when bindingFromNestInstanceExpr(value) resolves; the value of `mid` is an
// object literal `{ inner: service }`, which bindingFromNestInstanceExpr cannot resolve
// (falls through to bindingFromNestGetCall -> null), so `mid` is never registered. The
// mutation receiver `reg.mid.inner` is a PropertyAccessExpression whose OWNER `reg.mid`
// is also a PropertyAccess (not an identifier/object-literal), so bindingFromObjectProperty
// returns null -> classNameForMutableReceiver null -> markTargetMemberUnsafe no-ops: NO
// poison. At runtime reg.mid.inner === service, so the real body is dead, yet the direct
// `service` call + expect() confirm it. Single-level G2 IS poisoned; this nested form is not.
it("R9F-nested-object-literal: deep object-literal launder still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const reg = { mid: { inner: service } };
  reg.mid.inner.uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
