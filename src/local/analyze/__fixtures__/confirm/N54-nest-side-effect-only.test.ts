import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

const packageClient = { upload: jest.fn() };

it("does not prove from a side-effect assertion that is not tied to the method result", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [ApplicationService, { provide: "PackageClient", useValue: packageClient }]
  }).compile();
  const service = moduleRef.get(ApplicationService);

  await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(packageClient.upload).toHaveBeenCalled();
});
