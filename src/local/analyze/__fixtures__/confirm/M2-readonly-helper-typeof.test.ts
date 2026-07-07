import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// read-only helper inspects the service (no mutation), then real target
it("proves: read-only helper then real target", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  function inspect(s) { return typeof s.uploadDefaultPackageFilesAndSetFileIds; }
  const kind = inspect(service);
  const r = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(kind).toBe("function");
  expect(r).toBeDefined();
});