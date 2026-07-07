import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Provider override under a COMPUTED provide token ([ApplicationService][0]); the
// substitution scanner resolves the token to null and never marks ApplicationService.
it("does not prove when the provider is overridden under a computed provide token", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [{ provide: [ApplicationService][0], useValue: { uploadDefaultPackageFilesAndSetFileIds: async () => true } }],
  }).compile();
  const service = moduleRef.get(ApplicationService);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});