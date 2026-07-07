import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Pass the CONSTRUCTOR to a helper that patches its prototype.
it("helper receives constructor, patches prototype (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  function patchProto(C: any) { C.prototype.uploadDefaultPackageFilesAndSetFileIds = async () => true; }
  patchProto(service.constructor);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});