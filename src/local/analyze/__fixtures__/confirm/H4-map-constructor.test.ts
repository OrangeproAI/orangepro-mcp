import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// instance in a Map constructor entry, fetched by string key and mutated
it("no prove: Map-constructor stash mutation", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const reg = new Map([["svc", service]]);
  reg.get("svc").uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(false);
});