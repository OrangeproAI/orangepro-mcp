import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

it("R8F-closure-ret: zero-arg helper returns the singleton from its closure; mutate the call result", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);

  const grab = () => service; // returns a closure-captured value, NOT a parameter
  grab().uploadDefaultPackageFilesAndSetFileIds = async () => true; // grab() === service -> replaces the real method

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});