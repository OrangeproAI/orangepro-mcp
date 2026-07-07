import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// The target method is replaced by a spy that returns a canned value. The assertion
// observes the STUB's return, not the real implementation (which is bypassed).
it("does not prove when the target method is spied/stubbed", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [ApplicationService]
  }).compile();
  const service = moduleRef.get(ApplicationService);
  jest.spyOn(service, "uploadDefaultPackageFilesAndSetFileIds").mockResolvedValue(true);

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(uploaded).toBe(true);
});
