import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

class StorageService {
  health(): string {
    return "ok";
  }
}

// Two REAL providers resolved from one TestingModule. A benign non-target call on
// the sibling service runs first (and is asserted), then the REAL target on the
// real ApplicationService is exercised and asserted. No provider is overridden. SHOULD prove.
it("uploads default package files alongside a sibling service", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [ApplicationService, StorageService]
  }).compile();
  const service = moduleRef.get(ApplicationService);
  const storage = moduleRef.get(StorageService);

  expect(storage.health()).toBe("ok");

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
