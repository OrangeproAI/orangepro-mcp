import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// The REAL service is pushed into a benign array registry literal (e.g. to assert how
// many services the harness wired up). No element is a substitute — the real upload is
// invoked directly on the real binding. SHOULD prove.
it("uploads default package files while tracked in a service registry", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const registry = [service];

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
  expect(registry).toHaveLength(1);
});