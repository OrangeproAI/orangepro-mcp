import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Prototype object captured from a fresh resolution into an UNBOUND local `proto`, then
// proto.<method> overwritten. The assignment receiver is a bare identifier (not
// `<Class>.prototype`), and `proto` is not a tracked instance binding.
it("does not prove when a captured prototype object's method is overwritten", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const proto = moduleRef.get(ApplicationService).constructor.prototype;
  proto.uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
