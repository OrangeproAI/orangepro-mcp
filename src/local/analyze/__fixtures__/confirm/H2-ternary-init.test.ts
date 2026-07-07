import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// alias via a ternary initializer (not a literal/get) then mutate
it("no prove: ternary-init alias mutation", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const h = (1 > 0 ? service : null);
  h.uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(false);
});