import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

jest.mock("./application.service", () => ({ ApplicationService: jest.fn() }));

const packageClient = { upload: jest.fn() };

it("does not prove a mocked service", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [ApplicationService, { provide: "PackageClient", useValue: packageClient }]
  }).compile();
  const service = moduleRef.get(ApplicationService);

  await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(packageClient.upload).toHaveBeenCalled();
});
