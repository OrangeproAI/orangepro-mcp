import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Launder the mutation receiver through an object PROPERTY. `bag.ref` is the same
// singleton, so overwriting bag.ref.<method> overwrites service.<method> too — the
// real body is dead. But the patch's receiver is a PropertyAccessExpression, which
// classNameFromNestInstanceExpr does not resolve, so the class is never poisoned.
it("R7F objprop laundered stub still proves (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const bag = { ref: service };
  bag.ref.uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(false);
});
