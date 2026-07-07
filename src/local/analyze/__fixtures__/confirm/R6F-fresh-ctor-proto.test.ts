import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Class reached via a SECOND moduleRef.get(...).constructor stored in an UNBOUND local
// `ctor`, then ctor.prototype.<method> overwritten. The identifier ApplicationService is
// never written in a `<Class>.prototype.m =` position, so markMemberAssignment cannot
// resolve the class name from `ctor`.
it("does not prove when the method is replaced via a freshly-resolved constructor's prototype", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const ctor = moduleRef.get(ApplicationService).constructor;
  ctor.prototype.uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
