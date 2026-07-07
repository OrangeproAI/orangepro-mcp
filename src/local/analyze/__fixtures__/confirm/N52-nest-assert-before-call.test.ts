import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

const packageClient = { upload: jest.fn() };

it("does not prove when the side-effect assertion precedes the service call", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [ApplicationService, { provide: "PackageClient", useValue: packageClient }]
  }).compile();
  const service = moduleRef.get(ApplicationService);

  expect(packageClient.upload).toHaveBeenCalled();

  await service.uploadDefaultPackageFilesAndSetFileIds();
});
