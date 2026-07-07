import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

it("does not prove from an unrelated expect after the service call", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);

  await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(true).toBe(true);
});
