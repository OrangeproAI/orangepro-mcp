import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Helper receives the instance but reaches THROUGH it to the prototype.
it("helper mutates param's prototype (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  function patch(s: any) { s.constructor.prototype.uploadDefaultPackageFilesAndSetFileIds = async () => true; }
  patch(service);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});