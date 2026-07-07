import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// 2-level helper: outer passes to inner which mutates (interprocedural depth)
it("no prove: 2-level helper mutation", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  function inner(s) { s.uploadDefaultPackageFilesAndSetFileIds = async () => true; }
  function outer(s) { inner(s); }
  outer(service);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});