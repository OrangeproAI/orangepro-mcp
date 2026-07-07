import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Real ApplicationService via TestingModule; the real target is called once per
// input in a loop and each awaited result is bound to a const and asserted
// in-block. No substitution — the loop only re-exercises the real method. SHOULD prove.
it("uploads default package files for every input", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);

  const inputs = ["alpha", "beta", "gamma"];
  for (const input of inputs) {
    const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds(input);
    expect(uploaded).toBe(true);
  }
});
