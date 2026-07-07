import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// prototype patch in beforeEach (class identifier mentioned)
describe("x03", () => {
  let service;
  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
    service = moduleRef.get(ApplicationService);
    jest.spyOn(ApplicationService.prototype, "uploadDefaultPackageFilesAndSetFileIds").mockResolvedValue(true);
  });
  it("no prove: prototype spied in beforeEach", async () => {
    const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
    expect(uploaded).toBe(true);
  });
});