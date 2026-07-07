import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Method overwritten via service.constructor.prototype — chained, not a bare ClassName.prototype identifier.
it("does not prove when the method is overwritten via service.constructor.prototype", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  service.constructor.prototype.uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
