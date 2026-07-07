import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// ATTACK: the DI token is aliased to a local const first, so the providers array never
// literally pairs `ApplicationService` with `useValue` — a naive textual/identity check
// could miss it. Identity must resolve through the alias: the real target is replaced by
// a stub and `service.upload...()` hits the fake. Must NOT prove (aliased substitution).
const SERVICE_TOKEN = ApplicationService;
const fake = { uploadDefaultPackageFilesAndSetFileIds: async () => true };
it("does not prove when an aliased token is substituted with a stub", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [{ provide: SERVICE_TOKEN, useValue: fake }]
  }).compile();
  const service = moduleRef.get(SERVICE_TOKEN);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
