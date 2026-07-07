import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Array-of-objects: `[{ svc: service }][0].svc`. Unlike G4/R7F-arridx (array element IS
// the instance, whose receiver is an ElementAccess that bindingFromArrayElement resolves),
// here the final receiver is `.svc` (a PropertyAccess) whose OWNER is the element-access
// `[{svc:service}][0]`. bindingFromObjectProperty only descends an identifier or an object
// literal owner, so an element-access owner yields null -> classNameForMutableReceiver null
// -> markTargetMemberUnsafe no-ops: NO poison. At runtime that element IS service, so the
// overwrite kills the real body, yet the direct `service` call + expect() confirm.
it("R9F-array-of-objects-index-prop: object-in-array launder still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  [{ svc: service }][0].svc.uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
