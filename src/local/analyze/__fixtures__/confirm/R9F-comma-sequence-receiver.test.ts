import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Comma/sequence-operator receiver. `(0, service)` is the SAME instance at runtime, but
// bindingFromNestInstanceExpr only handles ||, ?? and && binary operators (confirm.ts:1172-1179)
// -- a CommaToken BinaryExpression (left intact by unwrapExpression) is unresolved and falls to
// bindingFromNestGetCall -> null. The write `(0, service).<target> =` thus poisons nothing
// (markMemberAssignment -> classNameForMutableReceiver = null). The real method is overwritten
// (comma returns the right operand = service), yet the clean `service.upload...()` use + expect()
// confirm it.
it("R9F-comma-sequence-receiver: comma-operator receiver still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  (0, service).uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
