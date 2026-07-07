import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Pure read-only helper: derives a log label, never mutates or substitutes the service.
function serviceLabel(svc: ApplicationService): string {
  return `wired:${svc.constructor.name}`;
}

it("uploads default package files (logs the wired service)", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [ApplicationService]
  }).compile();
  const service = moduleRef.get(ApplicationService);

  const label = serviceLabel(service);
  expect(label).toBe("wired:ApplicationService");

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(uploaded).toBe(true);
});
