import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// a parametrized scenario tuple pairs [service, methodName, labelFn] purely for table
// metadata — no applier ever assigns the fn — yet the real target runs and is asserted.
it("R9L-scenario-tuple: real target despite a [service, methodName, fn] metadata tuple", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const scenarios = [
    [service, "uploadDefaultPackageFilesAndSetFileIds", () => "ok"]
  ];
  expect(scenarios).toHaveLength(1);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
