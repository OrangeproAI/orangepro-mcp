import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// push instance into a non-literal array, then index+mutate
it("no prove: array push-then-index mutation", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const arr = [];
  arr.push(service);
  arr[0].uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(false);
});