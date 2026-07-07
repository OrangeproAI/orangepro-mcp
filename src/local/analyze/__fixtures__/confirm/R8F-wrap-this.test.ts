import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Wrapper class holds the singleton and mutates it through a method via `this.target`.
class Wrapper {
  target: any;
  constructor(t: any) { this.target = t; }
  stub(): void { this.target.uploadDefaultPackageFilesAndSetFileIds = async () => true; }
}

it("R8F-wrap-this: mutator reached only via a wrapper method, instance passed through `new`", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);

  const w = new Wrapper(service); // service laundered into a class field
  w.stub();                       // mutates this.target (=== service) -> replaces the real method

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});