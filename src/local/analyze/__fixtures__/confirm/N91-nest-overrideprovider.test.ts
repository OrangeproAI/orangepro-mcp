import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Idiomatic NestJS: build with the real provider, then .overrideProvider().useValue()
// swaps it for a stub. get(ApplicationService) returns the stub; real code never runs.
const fakeService = { uploadDefaultPackageFilesAndSetFileIds: async () => true };

it("does not prove when overrideProvider().useValue() swaps the target", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] })
    .overrideProvider(ApplicationService)
    .useValue(fakeService)
    .compile();
  const service = moduleRef.get(ApplicationService);

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(uploaded).toBe(true);
});
