import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// The DI container provides a CANNED FAKE for the target. module.get(ApplicationService)
// returns this stub — the real uploadDefaultPackageFilesAndSetFileIds NEVER runs.
const fakeService = { uploadDefaultPackageFilesAndSetFileIds: async () => true };

it("does not prove when the provider is overridden with a useValue stub", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [{ provide: ApplicationService, useValue: fakeService }]
  }).compile();
  const service = moduleRef.get(ApplicationService);

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(uploaded).toBe(true);
});
