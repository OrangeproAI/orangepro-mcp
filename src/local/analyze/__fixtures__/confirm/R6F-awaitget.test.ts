import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// The real singleton is grabbed a second time through `await moduleRef.get(...)`.
// classBindingFromExpr never unwraps an AwaitExpression, so `stub` is NOT recorded
// as an instance binding; patching its own method is therefore neither marked nor
// poisoned, while the clean `svc` binding carries the "proven" call.
it("await-wrapped get handle still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const stub = await moduleRef.get(ApplicationService);
  stub.uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const svc = moduleRef.get(ApplicationService);
  const uploaded = await svc.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});