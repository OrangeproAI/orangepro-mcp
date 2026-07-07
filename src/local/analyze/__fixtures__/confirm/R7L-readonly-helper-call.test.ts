import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// `inspect` is genuinely read-only: it CALLS a benign non-target lifecycle method
// and READS a property on the real service — it never assigns/replaces any member,
// so the target's identity is untouched. The real target is then asserted. SHOULD prove.
function inspect(svc: ApplicationService): string {
  svc.onModuleInit();
  return svc.constructor.name;
}

it("uploads after a read-only inspection helper runs", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);

  expect(inspect(service)).toBe("ApplicationService");

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
