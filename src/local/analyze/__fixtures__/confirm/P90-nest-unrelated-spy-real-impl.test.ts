import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Real ApplicationService runs; an UNRELATED object is spied. Must stay provable
// (over-correction guard: an unrelated spy must not poison the real target).
it("proves when the real target runs and only an unrelated object is spied", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const logger = { log: (_: string) => {} };
  jest.spyOn(logger, "log");
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
