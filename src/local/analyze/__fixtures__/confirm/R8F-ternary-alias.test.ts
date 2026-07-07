import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// A conditional whose arms are the instance; unwrapExpression never descends a ternary.
it("R8F ternary-aliased laundered stub still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const alias = (1 > 0 ? service : service);
  alias.uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(false);
});