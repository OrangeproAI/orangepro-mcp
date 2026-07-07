import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

const packageClient = { upload: jest.fn() };

it("uploads default package files", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [ApplicationService, { provide: "PackageClient", useValue: packageClient }]
  }).compile();
  const service = moduleRef.get(ApplicationService);

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(uploaded).toBe(true);
});
