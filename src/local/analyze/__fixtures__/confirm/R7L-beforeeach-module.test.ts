import { Test, TestingModule } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// The TestingModule is compiled in beforeEach and stored; each it() resolves the
// REAL service from the shared module and exercises the real target. No override. SHOULD prove.
let moduleRef: TestingModule;

beforeEach(async () => {
  moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
});

it("resolves the real service per test and uploads", async () => {
  const service = moduleRef.get(ApplicationService);

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(uploaded).toBe(true);
});
