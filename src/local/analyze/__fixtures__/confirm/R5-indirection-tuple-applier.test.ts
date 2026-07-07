import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Array of [obj, key, fn] tuples applied by a generic loop: receiver `o` is a
// destructured loop variable (not an instance binding) AND key `k` is dynamic.
it("tuple-applier indirection still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const muts = [[service, "uploadDefaultPackageFilesAndSetFileIds", async () => true]];
  for (const [o, k, f] of muts) {
    o[k] = f;
  }
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
