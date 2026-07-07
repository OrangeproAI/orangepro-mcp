import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Destructuring-ASSIGNMENT launder (not a declaration). `({ svc: s } = { svc: service })` aliases
// the same singleton, but the binary-expr branch binds instanceBindings only when node.left is a
// plain Identifier (confirm.ts:1972-1978); an ObjectLiteral LHS hits `!ts.isIdentifier(node.left)`
// -> forEachChild+return, so `s` is never bound. The later `s.<target> =` write therefore poisons
// nothing (markMemberAssignment -> classNameForMutableReceiver(s) = null). At runtime s === service,
// so the real method is overwritten, yet the clean `service.upload...()` use + expect() confirm it.
it("R9F-destructure-assign: destructuring assignment alias still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  let s: any;
  ({ svc: s } = { svc: service });
  s.uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
