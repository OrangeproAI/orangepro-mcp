import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

it("uploads default package files (records provider name)", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [ApplicationService]
  }).compile();
  const service = moduleRef.get(ApplicationService);

  // Non-target read on the real instance — used to label the assertion below.
  const provider = service.constructor.name;

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(uploaded).toBe(true);
  expect(provider).toBe("ApplicationService");
});
