import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Real target wired alongside a stubbed COLLABORATOR under a non-target string token.
// The collaborator instance is resolved and passed as an argument into the real
// target call. Stubbing/reading another provider must not poison the target, and an
// argument is not a substitution — the real method body executes and is asserted.
it("proves when a stubbed collaborator is passed into the real target call", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [ApplicationService, { provide: "PackageClient", useValue: { upload: jest.fn() } }]
  }).compile();
  const service = moduleRef.get(ApplicationService);
  const client = moduleRef.get("PackageClient");
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds(client);
  expect(uploaded).toBe(true);
});
