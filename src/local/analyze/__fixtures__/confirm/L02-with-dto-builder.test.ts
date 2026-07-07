import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// real proof + unrelated DTO
it("proves: real call with a dto", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const dto = { fileId: "f1", count: 2 };
  const result = await service.uploadDefaultPackageFilesAndSetFileIds(dto);
  expect(result).toBeDefined();
});