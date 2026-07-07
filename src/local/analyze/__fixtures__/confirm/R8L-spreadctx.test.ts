import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// A base config object is spread into a new context literal that also holds the REAL
// service under a named key. Spread + real instance, zero substitution — the real
// method runs on the real binding. SHOULD prove.
it("uploads default package files via a spread context literal", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const base = { region: "us", retries: 2 };
  const ctx = { ...base, subject: service };

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
  expect(ctx.region).toBe("us");
});