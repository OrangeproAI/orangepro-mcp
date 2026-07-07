import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// real proof + assert via a getter method
it("proves: act then assert via real getter", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  await service.uploadDefaultPackageFilesAndSetFileIds();
  const stored = await service.findStored("f1");
  expect(stored).toBeDefined();
});