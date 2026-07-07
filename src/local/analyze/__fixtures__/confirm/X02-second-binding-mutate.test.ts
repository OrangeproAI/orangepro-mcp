import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// second get() binding of same class, mutate it
it("no prove: second binding mutated", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const other = moduleRef.get(ApplicationService);
  other.uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});