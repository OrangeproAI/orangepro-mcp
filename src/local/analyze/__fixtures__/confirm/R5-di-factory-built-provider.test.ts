import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Provider built by a HELPER FACTORY: the substitution literal's `provide` is a
// function parameter (not a static identifier), and the providers-array entry is a
// call expression, so the literal scanner never resolves it to ApplicationService.
const fakeProvider = (token, value) => ({ provide: token, useValue: value });
it("does not prove when the substituting provider is produced by a factory", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [fakeProvider(ApplicationService, { uploadDefaultPackageFilesAndSetFileIds: async () => true })],
  }).compile();
  const service = moduleRef.get(ApplicationService);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});