import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Stash the singleton in a Map under a STRING key, fetch it, mutate it. The patch's
// receiver is `reg.get("svc")` — a `.get(...)` call — so classNameFromNestGetCall fires,
// but its argument is a string literal, not a class token, so classNameFromToken returns
// null and the class is never poisoned. The clean `service.<method>` call proves.
it("R7F map.get(string) laundered stub still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const reg = new Map<string, any>();
  reg.set("svc", service);
  reg.get("svc").uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(false);
});
