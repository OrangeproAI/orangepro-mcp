import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// service passed to a read-only helper that CALLS the real target (no mutation)
it("proves: read-only helper invokes the real target", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  function run(s) { return s.uploadDefaultPackageFilesAndSetFileIds(); }
  const r = await run(service);
  expect(r).toBeDefined();
});