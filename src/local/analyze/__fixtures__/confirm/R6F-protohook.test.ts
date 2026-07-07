import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Timing: the real class prototype is overwritten inside a beforeEach hook through a
// non-binding handle's `.constructor.prototype`. The handle is await-wrapped (not a
// recorded binding), and markMemberAssignment's prototype branch only marks when
// `proto.expression` is a bare identifier — here it is `handle.constructor`, so the
// write is never marked. The clean `svc` binding then carries the proven call.
let moduleRef: any;
beforeEach(async () => {
  moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const handle = await moduleRef.get(ApplicationService);
  handle.constructor.prototype.uploadDefaultPackageFilesAndSetFileIds = async () => true;
});
it("beforeEach prototype patch via non-binding handle still proves (FALSE)", async () => {
  const svc = moduleRef.get(ApplicationService);
  const uploaded = await svc.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});