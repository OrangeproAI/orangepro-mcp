import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// instance via Object.values of a literal, indexed and mutated
it("no prove: Object.values stash mutation", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Object.values({ a: service })[0].uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(false);
});