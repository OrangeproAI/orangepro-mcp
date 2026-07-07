import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Minimal, fully-legit real proof: real ApplicationService via TestingModule,
// real target call, awaited result bound to a const and asserted. SHOULD prove.
it("uploads default package files and returns the result", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);

  const result = await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(result).toBe(true);
});
