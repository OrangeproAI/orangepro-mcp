import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// benign property read on the service, then real target
it("proves: benign read then real target", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const tag = service.constructor.name;
  const r = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(tag).toBeDefined();
  expect(r).toBeDefined();
});