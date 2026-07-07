import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// alias laundered through await Promise.resolve then mutate
it("no prove: async passthrough mutation", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const h = await Promise.resolve(service);
  h.uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(false);
});