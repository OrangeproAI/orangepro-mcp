import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Alias Object.getPrototypeOf into a local, then patch the prototype through the alias.
it("alias getPrototypeOf then patch prototype (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const gp = Object.getPrototypeOf;
  gp(service).uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});