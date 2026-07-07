import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Textbook NestJS test: sanity-check the resolved provider is wired, then exercise
// the REAL target and assert its REAL result. SHOULD prove.
it("wires the service and uploads default package files", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);

  expect(service).toBeDefined();

  const created = await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(created).toBe(true);
});
