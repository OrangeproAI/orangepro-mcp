import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Registers the resolved service with a read-only teardown tracker (a common
// harness pattern), then exercises the REAL target and asserts its REAL result.
// The helper does not mutate or replace the target. SHOULD prove.
const opened: ApplicationService[] = [];
function trackForCleanup(s: ApplicationService): void {
  opened.push(s);
}

it("uploads default package files for the tracked service", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  trackForCleanup(service);

  const result = await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(result).toBe(true);
});
