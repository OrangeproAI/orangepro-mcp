import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Mutate through an array-literal index `[service][0]`. The patch receiver is an
// ElementAccessExpression, which neither classNameFromNestInstanceExpr nor
// classNameFromPrototypeExpr handle (only identifiers and `.get(Class)` calls), so no
// poison. `[service][0]` is the same instance; the tracked `service` call proves.
it("R7F array-index laundered stub still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  [service][0].uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(false);
});
