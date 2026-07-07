import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Target method replaced by a DIRECT instance property assignment of a jest.fn
// stub (not spyOn, not prototype, not whole-binding reassignment). Real body bypassed.
it("does not prove when the target method is stubbed via instance property assignment", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  service.uploadDefaultPackageFilesAndSetFileIds = jest.fn().mockResolvedValue(true);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
