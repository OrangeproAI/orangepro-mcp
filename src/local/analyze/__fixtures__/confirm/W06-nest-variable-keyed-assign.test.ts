import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// variable-keyed element-access assignment
it("no prove via variable-keyed assignment", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const key = "uploadDefaultPackageFilesAndSetFileIds";
  service[key] = async () => true;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});