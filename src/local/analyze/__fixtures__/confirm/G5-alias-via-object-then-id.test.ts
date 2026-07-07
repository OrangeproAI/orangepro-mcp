import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// alias laundered through an object property into a plain identifier
it("no prove: object->identifier alias mutation", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const o = { svc: service };
  const handle = o.svc;
  handle.uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});