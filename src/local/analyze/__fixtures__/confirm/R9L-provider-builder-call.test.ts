import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// providers built by a factory CALL that merely references the class; the real
// ApplicationService is still a genuine provider and its method is never substituted.
function appProviders(svc) {
  return [svc];
}
it("R9L-provider-builder-call: real target despite a provider-factory call mentioning the class", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: appProviders(ApplicationService)
  }).compile();
  const service = moduleRef.get(ApplicationService);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
