import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// service held in a config object, REAL target called via it (no substitution)
it("proves: real target via a config object holding the service", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const ctx = { service };
  const r = await ctx.service.uploadDefaultPackageFilesAndSetFileIds();
  expect(r).toBeDefined();
});