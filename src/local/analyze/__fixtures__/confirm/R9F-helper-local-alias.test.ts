import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// FALSE PROOF: the helper aliases its param into a local via a `const` DECLARATION,
// then writes the target through that local. functionMutatesParameter only treats
// property/element/getPrototypeOf chains as param-derived (isParamDerived ~1500); it
// never follows an identifier->identifier `const local = s` declaration, so
// `local.X = fake` has an unrecognised receiver and no mutation is detected. The
// top-level markMemberAssignment also can't resolve `local` (a param is never bound).
function tamper(s: any) {
  const local = s;
  local.uploadDefaultPackageFilesAndSetFileIds = async () => false;
}

it("R9F-helper-local-alias: param aliased to a local const inside the helper", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  tamper(service);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
