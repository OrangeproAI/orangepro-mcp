import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Prototype obtained via Reflect.getPrototypeOf(service) then the method mutated on the aliased proto. Not <Class>.prototype.m, and proto is not an instance binding. Real body bypassed.
it("does not prove when the prototype is mutated via a Reflect.getPrototypeOf alias", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const proto = Reflect.getPrototypeOf(service);
  proto.uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
