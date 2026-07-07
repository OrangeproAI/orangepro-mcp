import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Real prototype reached via instance.__proto__ and the method overwritten on it.
it("does not prove when the method is overwritten via service.__proto__", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  service.__proto__.uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
