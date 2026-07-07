import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// A closure RETURNS a CAPTURED instance (a free variable, not a parameter).
it("R8F closure returns captured instance laundered stub still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const grab = () => service;
  grab().uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(false);
});