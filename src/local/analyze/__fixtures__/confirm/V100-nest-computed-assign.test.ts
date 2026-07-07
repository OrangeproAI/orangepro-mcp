import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Target method stubbed via COMPUTED (bracket) member assignment; real body bypassed.
it("does not prove when the target method is stubbed via computed member assignment", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  service["uploadDefaultPackageFilesAndSetFileIds"] = jest.fn().mockResolvedValue(true);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
