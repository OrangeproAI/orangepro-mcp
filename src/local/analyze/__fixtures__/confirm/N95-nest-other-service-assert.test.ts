import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Two services resolved; the target method is called for its side effect, but the
// assertion observes a DIFFERENT resolved service's value, not the target's result.
class OtherService {
  status(): boolean {
    return true;
  }
}

it("does not prove when the assertion observes a different DI service", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [ApplicationService, OtherService]
  }).compile();
  const service = moduleRef.get(ApplicationService);
  const other = moduleRef.get(OtherService);

  await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(other.status()).toBe(true);
});
