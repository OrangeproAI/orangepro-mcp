import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Target method replaced via jest.replaceProperty; real body bypassed.
it("does not prove when the target method is replaced via jest.replaceProperty", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  jest.replaceProperty(service as any, "uploadDefaultPackageFilesAndSetFileIds", jest.fn().mockResolvedValue(true));
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
