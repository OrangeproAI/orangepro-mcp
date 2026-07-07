import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// getter returns the closure-captured instance (not a param) then mutate result
it("no prove: closure-return getter mutation", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  function getSvc() { return service; }
  getSvc().uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(false);
});