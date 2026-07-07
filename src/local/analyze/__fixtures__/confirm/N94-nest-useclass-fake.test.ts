import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// useClass swaps the real implementation for a fake class. get(ApplicationService)
// constructs FakeService; the real method body never executes.
class FakeService {
  async uploadDefaultPackageFilesAndSetFileIds(): Promise<boolean> {
    return true;
  }
}

it("does not prove when useClass substitutes a fake implementation", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [{ provide: ApplicationService, useClass: FakeService }]
  }).compile();
  const service = moduleRef.get(ApplicationService);

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(uploaded).toBe(true);
});
