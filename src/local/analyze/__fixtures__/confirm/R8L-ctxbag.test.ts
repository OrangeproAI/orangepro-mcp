import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// The REAL service is collected into a benign DI "context bag" object literal so a
// later assertion can read sibling test metadata off one struct. The bag does NOT
// substitute anything (no useValue/useClass/mock) — the real method is still called
// directly on the real binding. SHOULD prove.
it("uploads default package files using a context-bag fixture", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const ctx = { app: service, tenantId: "t-1", attempts: 0 };

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
  expect(ctx.tenantId).toBe("t-1");
});