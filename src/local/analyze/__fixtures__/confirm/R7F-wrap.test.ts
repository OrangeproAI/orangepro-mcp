import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Container-wrap indirection. The instance is hidden inside an object literal `{ svc: service }`
// before being handed to the helper, and the helper writes `ctx.svc.<method>` (a property of
// the param, not the param itself). markHelperMutation computes classNameForMutableReceiver on
// the RAW argument `{ svc: service }`; an object literal is neither an identifier nor a
// moduleRef.get() call, so it resolves to null and functionMutatesParameter is never even
// consulted. Even if it were, the write target `ctx.svc.method` has receiver `ctx.svc` (a
// property access), so isParamRef(ctx.svc) is false -> still not a param mutation. ApplicationService
// is never poisoned. At runtime applyAll unwraps the container and shadows the method on the real
// instance; the REAL body never runs, yet `service.upload...()` + expect() confirm it.
function applyAll(ctx: any) {
  ctx.svc.uploadDefaultPackageFilesAndSetFileIds = async () => true;
}

it("R7F-wrap object-wrapped instance still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  applyAll({ svc: service });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});