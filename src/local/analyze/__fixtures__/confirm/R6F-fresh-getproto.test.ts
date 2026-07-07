import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Same shape as the CAUGHT R5-proto-getPrototypeOf-assign, but the argument to
// Object.getPrototypeOf is a FRESH moduleRef.get(ApplicationService) instead of the
// bound `service`. The new instance-poison only inspects identifiers bound as Nest
// instances; this resolution is never assigned to a variable, so nothing is poisoned.
it("does not prove when the prototype of a freshly-resolved instance is mutated", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Object.getPrototypeOf(moduleRef.get(ApplicationService)).uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
