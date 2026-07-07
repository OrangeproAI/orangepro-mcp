import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

it("uploads default package files (registers service for teardown)", async () => {
  const created: ApplicationService[] = [];
  const moduleRef = await Test.createTestingModule({
    providers: [ApplicationService]
  }).compile();
  const service = moduleRef.get(ApplicationService);
  created.push(service);

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(uploaded).toBe(true);
  expect(created).toHaveLength(1);
});
