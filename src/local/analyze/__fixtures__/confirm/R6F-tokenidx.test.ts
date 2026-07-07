import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// The same singleton is resolved through a token read out of an array element.
// classBindingFromExpr requires the `.get(...)` argument to be a bare identifier;
// `tokens[0]` is an element access, so `stub` is NOT recorded as a binding and the
// own-method patch is never marked/poisoned. `svc` keeps the clean proven call.
const tokens = [ApplicationService];
it("element-access token handle still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const stub = moduleRef.get(tokens[0]);
  stub.uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const svc = moduleRef.get(ApplicationService);
  const uploaded = await svc.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});