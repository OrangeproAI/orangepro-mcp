import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// ATTACK: looks like ordinary DI wiring, but useFactory returns a CANNED object — the
// container hands back the fake, the real ApplicationService body never executes. The
// `service.upload...()` call hits the stub. Must NOT prove (substitution via factory).
it("does not prove when useFactory returns a canned fake instance", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      { provide: ApplicationService, useFactory: () => ({ uploadDefaultPackageFilesAndSetFileIds: async () => true }) }
    ]
  }).compile();
  const service = moduleRef.get(ApplicationService);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
