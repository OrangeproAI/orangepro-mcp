import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// LEGIT (must prove): `capture` only HOLDS the instance — it stores the reference
// into an outer variable, a benign read, not a write to any member of the service.
// Per the gate's own semantics holding the instance is benign, and the real target
// then runs and is asserted. But functionMutatesParameter's alias-assignment branch
// (~1518 `isIdentifier(left) && isParamDerived(right)`) flags `captured = s` as a
// mutation, so markHelperMutation poisons ApplicationService and the real, unmodified
// target use is wrongly rejected (over-correction).
let captured: ApplicationService | undefined;
function capture(s: ApplicationService) {
  captured = s;
}

it("R9L-helper-capture-instance: benign instance capture must not poison the target", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  capture(service);
  expect(captured).toBeDefined();
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
