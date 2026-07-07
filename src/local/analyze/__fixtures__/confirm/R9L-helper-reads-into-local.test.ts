import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// a read-only helper assigns a param-derived READ into a local (no mutation at all),
// then the real target runs and is asserted directly.
function describeService(s) {
  let label;
  label = s.constructor.name;
  return label;
}
it("R9L-helper-reads-into-local: real target after a helper reads a param property into a local", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  describeService(service);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
