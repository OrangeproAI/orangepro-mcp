import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// The binding is reassigned to a fake before use. The confirmer ties the `service`
// symbol to the real class at decl time and never clears it on reassignment, so the
// call below hits the FAKE while still being credited to ApplicationService.
const fakeService = { uploadDefaultPackageFilesAndSetFileIds: async () => true };

it("does not prove when the resolved binding is overwritten by a fake", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [ApplicationService]
  }).compile();
  let service = moduleRef.get(ApplicationService);
  service = fakeService as any;

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(uploaded).toBe(true);
});
