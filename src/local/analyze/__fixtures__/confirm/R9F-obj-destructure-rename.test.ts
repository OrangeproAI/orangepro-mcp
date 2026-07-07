import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Object-destructuring RENAME launder. `const { svc: s } = { svc: service }` aliases the same
// singleton, but the variable-decl visit (confirm.ts:1944-1952) has no ObjectBindingPattern
// branch, so `s` is never entered into instanceBindings. The later `s.<target> =` write goes
// through markMemberAssignment -> classNameForMutableReceiver(s) = null (bindingFromNestInstanceExpr
// returns null for the unbound identifier) -> no class is poisoned. At runtime s === service, so
// the assignment shadows the real prototype method; the REAL body never runs, yet the get()-bound
// clean `service.upload...()` use + expect() confirm it.
it("R9F-obj-destructure-rename: object destructuring rename still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const { svc: s } = { svc: service };
  s.uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
