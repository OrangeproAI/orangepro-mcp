import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// forEach loop writes through a dynamic (non-literal) element-access key `k`,
// so propertyAccessName() returns null and the member-write is never attributed.
it("forEach dynamic-key indirection still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  [["uploadDefaultPackageFilesAndSetFileIds", async () => true]].forEach(([k, fn]) => {
    service[k] = fn;
  });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
