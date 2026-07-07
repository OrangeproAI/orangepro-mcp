import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// instance stashed in a Map, fetched and mutated
it("no prove: Map stash mutation", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const reg = new Map();
  reg.set("svc", service);
  reg.get("svc").uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});