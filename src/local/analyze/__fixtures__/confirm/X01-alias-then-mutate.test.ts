import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// alias the instance, mutate the alias
it("no prove: alias then mutate", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const s2 = service;
  s2.uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});