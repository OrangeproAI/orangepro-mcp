import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// The DI-resolved binding is swapped to a fake via a LOGICAL-ASSIGNMENT (&&=), not a
// plain `=`; the binding tracker only clears the instance binding on EqualsToken, so
// `service` stays credited to ApplicationService while runtime now points at the fake.
const fakeService = { uploadDefaultPackageFilesAndSetFileIds: async () => true };
it("does not prove when the resolved binding is rebound via &&=", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  let service = moduleRef.get(ApplicationService);
  service &&= fakeService;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});