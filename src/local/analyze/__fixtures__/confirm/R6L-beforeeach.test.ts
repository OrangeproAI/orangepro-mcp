import { Test, TestingModule } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

let service: ApplicationService;

beforeEach(async () => {
  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [ApplicationService]
  }).compile();
  service = moduleRef.get(ApplicationService);
});

it("uploads default package files", async () => {
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(uploaded).toBe(true);
});
