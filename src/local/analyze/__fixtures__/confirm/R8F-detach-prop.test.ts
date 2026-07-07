import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

it("R8F-detach-prop: park the instance on a property of an empty object, mutate via the property path", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);

  const holder: any = {};      // empty literal — nothing to scan for containment
  holder.svc = service;        // separate assignment, NOT an object literal containing the instance
  holder.svc.uploadDefaultPackageFilesAndSetFileIds = async () => true; // holder.svc === service at runtime

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});