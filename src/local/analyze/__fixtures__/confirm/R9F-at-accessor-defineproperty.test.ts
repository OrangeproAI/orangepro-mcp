import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Array `.at(0)` accessor: arr is a registered array container, but the mutation receiver
// `arr.at(0)` is a CallExpression. bindingFromNestInstanceExpr only resolves CallExpressions
// via .get()/map.get/Promise.resolve/pass-through (~1187-1194); `.at` matches none, and
// bindingFromArrayElement only handles bracket `arr[0]` element access. So
// Object.defineProperty's receiver resolves to null -> no poison. Bracket `arr[0]` would be
// caught (R7F-arridx); `.at(0)` is the same instance but escapes. Real body overwritten.
it("R9F-at-accessor-defineproperty: arr.at(0) accessor escapes reflective poison (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const arr = [service];
  Object.defineProperty(arr.at(0), "uploadDefaultPackageFilesAndSetFileIds", { value: async () => false });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
