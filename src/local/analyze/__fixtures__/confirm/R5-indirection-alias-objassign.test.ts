import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Object.assign is aliased to a local `assign`; the gate keys on syntactic
// calleeText === "Object.assign", so the call `assign(...)` is invisible.
it("aliased Object.assign indirection still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const assign = Object.assign;
  assign(service, { uploadDefaultPackageFilesAndSetFileIds: async () => true });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
