import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// real proof + service passed to a benign helper
it("proves: benign helper then real target", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  function arrange(s) { void s; }
  arrange(service);
  const result = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(result).toBeDefined();
});