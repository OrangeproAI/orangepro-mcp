import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Identity helper that RETURNS its argument. R7F-passthru mutates the call result
// DIRECTLY (`passThrough(service).method = ...`) and is caught by classNameFromPassThroughCall.
// Here the returned instance is stored in a local first, then the LOCAL is mutated.
const passThrough = <T>(x: T): T => x;

it("R8F-pt-local: helper-returned instance laundered into a local, then mutated", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);

  const alias = passThrough(service); // alias === service at runtime
  alias.uploadDefaultPackageFilesAndSetFileIds = async () => true; // replaces the real method on the shared instance

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});