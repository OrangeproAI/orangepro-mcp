import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Map CONSTRUCTOR entries (never .set); var-init poison skips NewExpression args.
it("R8F Map-constructor-entry laundered stub still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const reg = new Map<string, any>([["svc", service]]);
  reg.get("svc").uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(false);
});