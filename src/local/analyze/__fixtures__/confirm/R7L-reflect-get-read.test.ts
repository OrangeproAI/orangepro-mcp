import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Read/write asymmetry: Reflect.get READS the method handle off the real instance for
// a sanity assertion — it is the mirror image of the Reflect.set substitution attack,
// but it mutates nothing. The real target is then invoked and asserted, so it proves.
it("proves when Reflect.get only reads the method handle, then runs the real target", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const handle = Reflect.get(service, "uploadDefaultPackageFilesAndSetFileIds");
  expect(typeof handle).toBe("function");
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
