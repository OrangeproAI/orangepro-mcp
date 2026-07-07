import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// service held in an array, REAL target called via index (no substitution)
it("proves: real target via array element", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const svcs = [service];
  const r = await svcs[0].uploadDefaultPackageFilesAndSetFileIds();
  expect(r).toBeDefined();
});