import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Real target call asserted directly via the async `.resolves` matcher. SHOULD prove.
it("resolves true from the real upload", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);

  await expect(service.uploadDefaultPackageFilesAndSetFileIds()).resolves.toBe(true);
});
