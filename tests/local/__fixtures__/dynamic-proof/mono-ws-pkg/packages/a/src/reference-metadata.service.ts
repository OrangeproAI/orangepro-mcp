import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ReferenceMetadataResult {
  builtSiblingConfig: boolean;
  typeOnlySiblingConfig: boolean;
}

export class ReferenceMetadataService {
  check(): ReferenceMetadataResult {
    const here = dirname(fileURLToPath(import.meta.url));
    return {
      builtSiblingConfig: existsSync(resolve(here, "../../b/tsconfig.json")),
      typeOnlySiblingConfig: existsSync(resolve(here, "../../types/tsconfig.json"))
    };
  }
}
