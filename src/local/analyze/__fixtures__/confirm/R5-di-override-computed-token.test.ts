import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// overrideProvider with a COMPUTED token ([ApplicationService][0]); the overrideProvider
// branch resolves the token to null, so ApplicationService is never marked substituted.
it("does not prove when overrideProvider targets a computed token", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] })
    .overrideProvider([ApplicationService][0])
    .useValue({ uploadDefaultPackageFilesAndSetFileIds: async () => true })
    .compile();
  const service = moduleRef.get(ApplicationService);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});