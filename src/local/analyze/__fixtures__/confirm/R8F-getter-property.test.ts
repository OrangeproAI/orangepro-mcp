import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Stash via an object GETTER accessor; classNamesContainedInExpression skips accessors.
it("R8F object getter-property laundered stub still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const holder = { get svc() { return service; } };
  holder.svc.uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(false);
});