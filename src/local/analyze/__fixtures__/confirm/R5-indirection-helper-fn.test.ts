import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Substitution happens INSIDE a helper: the member-write receiver is the helper's
// parameter `s`, which is never registered as an instance binding.
function patch(s) {
  s.uploadDefaultPackageFilesAndSetFileIds = async () => true;
}
it("helper-function indirection still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  patch(service);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
