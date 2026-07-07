import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Spread-built array container + constructor.prototype mutation. `base` is a registered
// array, but `arr = [...base]` is built from a SpreadElement, which recordArrayElementBindings
// skips (~1365: bindingFromNestInstanceExpr of a spread is null), so arr has NO arrayElement
// binding. The prototype write receiver `arr[0].constructor.prototype` walks
// classNameFromPrototypeExpr -> classNameFromConstructorExpr -> classNameFromNestInstanceExpr(arr[0])
// -> bindingFromArrayElement(arr,0) -> unset -> null. No poison. arr[0] === service at runtime,
// so ApplicationService.prototype.<method> is replaced; the real body is dead. `service` proves clean.
it("R9F-spread-array-protoctor: spread-array constructor.prototype escapes poison (FALSE)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const base = [service];
  const arr = [...base];
  arr[0].constructor.prototype.uploadDefaultPackageFilesAndSetFileIds = async () => false;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
