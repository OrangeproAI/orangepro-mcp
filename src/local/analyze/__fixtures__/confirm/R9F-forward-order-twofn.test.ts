import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Forward-pass ordering escape. The confirmer visits the AST once, in source order, deciding
// mutation poison at visit-time (no fixpoint -- visit(testSf) at confirm.ts:2034). `poison()` is
// DECLARED before `bind()`, so when poison's body `shared.<target> =` is visited, `shared` is not
// yet in instanceBindings (bind's `shared = service` -- which WOULD bind it via classBindingFromExpr
// 1976-1978 -- has not been visited) -> markMemberAssignment sees a null receiver -> no poison.
// At runtime bind() runs first (shared = service), then poison() overwrites the method; the REAL
// body never runs, yet the clean `service.upload...()` use + expect() confirm it.
it("R9F-forward-order-twofn: bind-after-poison ordering still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  let shared: any;
  function poison() {
    shared.uploadDefaultPackageFilesAndSetFileIds = async () => false;
  }
  function bind() {
    shared = service;
  }
  bind();
  poison();
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
