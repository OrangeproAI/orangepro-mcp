import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// FALSE PROOF: `mutate` writes the target through its SECOND param (index 1); the
// FIRST param is inert. `wrapper` forwards the service to BOTH positions. During the
// recursive wrapper->mutate analysis (~1549) the shared `seen` set is keyed on the
// FUNCTION only (~1489 `if (seen.has(fn)) return false`), not (fn,index): checking
// mutate@0 (no mutation) inserts `mutate` into `seen`, so the mutate@1 check short-
// circuits to false and the real mutation is never seen. The inner mutate(s,s) call
// can't poison either — `s` is wrapper's own (unbound) param.
function mutate(a: any, b: any) {
  void a;
  b.uploadDefaultPackageFilesAndSetFileIds = async () => false;
}
function wrapper(s: any) {
  mutate(s, s);
}

it("R9F-helper-seen-index: shared seen cache hides a later-index param mutation", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  wrapper(service);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
