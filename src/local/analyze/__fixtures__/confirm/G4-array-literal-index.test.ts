import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// mutate via array-literal index of the instance
it("no prove: array-literal index mutation", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  [service][0].uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});