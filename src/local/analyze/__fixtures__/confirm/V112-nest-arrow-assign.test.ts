import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Target method reassigned to a plain async arrow with NO jest.fn / mock on the RHS.
// Probes whether the gate poisons on the member WRITE itself, or only when the RHS
// is a recognizable mock factory. Real body bypassed either way.
it("does not prove when the target method is reassigned to a plain arrow", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  service.uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
