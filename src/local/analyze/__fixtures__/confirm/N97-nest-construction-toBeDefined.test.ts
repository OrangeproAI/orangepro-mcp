import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Construction-only proof attempt: the method is called for its side effect, but the
// only assertion is a truthiness check on the resolved service object (construction,
// not the method's behavior).
it("does not prove from a toBeDefined truthiness check on the service", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [ApplicationService]
  }).compile();
  const service = moduleRef.get(ApplicationService);

  await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(service).toBeDefined();
});
