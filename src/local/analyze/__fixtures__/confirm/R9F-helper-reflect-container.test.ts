import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// FALSE PROOF: a helper reflectively rewrites the target on a CONTAINER ELEMENT of
// its parameter. functionMutatesParameter's mutator-call branch (~1536) gates on
// isParamRef(args[0]) ONLY, and `bag.svc` is param-DERIVED (a property access), not
// the bare param identifier -> Reflect.set is not recognised as a mutation. (A direct
// `bag.svc.X = fake` assignment would be caught by the param-derived branch ~1526.)
function poison(bag: any) {
  Reflect.set(bag.svc, "uploadDefaultPackageFilesAndSetFileIds", async () => false);
}

it("R9F-helper-reflect-container: reflective rewrite of a param container element", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  poison({ svc: service });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
