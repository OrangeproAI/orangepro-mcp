import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// instance stashed in an object property, mutated through it
it("no prove: object-property stash mutation", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const reg = { svc: service };
  reg.svc.uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});