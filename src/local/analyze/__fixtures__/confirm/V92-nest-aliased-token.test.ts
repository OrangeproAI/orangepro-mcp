import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// A fake is provided under an ALIASED token (const TOKEN = ApplicationService).
const fake = { uploadDefaultPackageFilesAndSetFileIds: async () => true };
const TOKEN = ApplicationService;
it("does not prove when a fake is provided under an aliased token", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [{ provide: TOKEN, useValue: fake }] }).compile();
  const service = moduleRef.get(ApplicationService);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
