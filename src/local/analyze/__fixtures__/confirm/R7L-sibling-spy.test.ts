import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Identity-aware guard: a spy is installed on a DIFFERENT method of the REAL target
// instance (a lifecycle hook), not on uploadDefaultPackageFilesAndSetFileIds. The
// target method body still runs for real, so this must stay provable — spying a
// sibling method must not poison the un-spied target (sharper P90: same instance).
it("proves when a sibling method is spied but the target runs for real", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  jest.spyOn(service, "onModuleInit").mockResolvedValue(undefined);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
