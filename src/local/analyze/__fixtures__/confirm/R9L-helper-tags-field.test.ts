import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// a helper writes an UNRELATED field on the instance (NOT the target method) — benign
// tagging — then the real target runs and is asserted.
function track(s) {
  s.lastRunAt = Date.now();
}
it("R9L-helper-tags-field: real target after a helper tags an unrelated field", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  track(service);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
