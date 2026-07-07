import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

const packageClient = { upload: jest.fn() };

it("uploads default package files (with a DI sanity guard)", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [ApplicationService, { provide: "PackageClient", useValue: packageClient }]
  }).compile();
  const service = moduleRef.get(ApplicationService);

  // Ordinary arrange-time guard: confirm the real provider was wired before exercising it.
  expect(service).toBeInstanceOf(ApplicationService);

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(uploaded).toBe(true);
});
