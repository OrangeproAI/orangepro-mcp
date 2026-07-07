import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Two-hop interprocedural relay. `outer` NEVER writes its own param — it forwards the
// instance to a SECOND helper `inner`, and only `inner` overwrites the method.
// markHelperMutation runs functionMutatesParameter(outer, 0), which walks ONLY outer's
// lexical body. There it meets the call `inner(svc)`: arguments[0] is the param (isParamRef
// true) BUT mutatorNameFromExpr(inner) is null (a plain user function is not a known
// mutator), so the `name && ...` guard fails and nothing is flagged. functionMutatesParameter
// never fetches/descends inner's declaration. Inside inner, `s.method =` has receiver `s`
// (inner's param), which is not an instanceBinding, so markMemberAssignment ->
// classNameForMutableReceiver(s) returns null and adds no poison. At runtime outer(service)
// runs inner(service), shadowing the prototype method; the REAL body never executes, yet
// ApplicationService.uploadDefaultPackageFilesAndSetFileIds stays out of unsafeMemberTargets
// and the get()-bound, clean-src `service.upload...()` use + expect() confirm it.
function inner(s: any) {
  s.uploadDefaultPackageFilesAndSetFileIds = async () => true;
}
function outer(svc: any) {
  inner(svc);
}

it("R7F-relay two-hop helper relay still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  outer(service);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});