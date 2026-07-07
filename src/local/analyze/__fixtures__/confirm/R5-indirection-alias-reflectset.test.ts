import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Reflect.set is aliased to a local `set`; the reflective-mutator branch matches
// calleeText === "Reflect.set" only, so `set(service, "m", fn)` is invisible.
it("aliased Reflect.set indirection still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const set = Reflect.set;
  set(service, "uploadDefaultPackageFilesAndSetFileIds", async () => true);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
