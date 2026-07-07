import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// A pass-through call returns the SAME instance. The patch receiver is
// `passThrough(service)` — a CallExpression whose callee is a plain identifier, so
// classNameFromNestGetCall (which requires a `.get` PropertyAccess callee) returns null,
// and functionMutatesParameter sees the identity body `=> x` does not mutate its
// parameter, so markHelperMutation is a no-op. Class never poisoned.
const passThrough = (x: ApplicationService) => x;
it("R7F passthrough-call laundered stub still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  passThrough(service).uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(false);
});
