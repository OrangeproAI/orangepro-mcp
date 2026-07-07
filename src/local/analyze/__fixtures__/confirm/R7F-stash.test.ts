import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Param-to-outer-var stash. `stash` copies its param onto module-scope `holder`. The write
// `holder = s` is to a BARE identifier, so functionMutatesParameter(stash, 0)'s assignment
// branch (which requires the left to be a property/element access whose receiver isParamRef)
// does not fire -> returns false, no poison from the helper call. Crucially, classBindingFromExpr
// cannot resolve `s` (a plain parameter is neither an existing instanceBinding, a `new X()`, nor
// a `moduleRef.get(X)` call), so the `holder = s` assignment seen by visit binds NOTHING (it
// actually deletes any binding). `holder` is therefore never entered into instanceBindings.
// The later top-level `holder.upload... =` write goes through markMemberAssignment ->
// markTargetMemberUnsafe -> classNameForMutableReceiver(holder) = null (holder unknown) -> no
// poison. At runtime holder === service, so the assignment shadows the real method; the REAL
// body never runs, yet the target stays clean and `service.upload...()` + expect() confirm it.
let holder: any;
function stash(s: any) {
  holder = s;
}

it("R7F-stash param stashed on outer var still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  stash(service);
  holder.uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});