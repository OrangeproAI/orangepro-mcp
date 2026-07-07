// Bundler-resolution fixture test. Read from disk by the resolver tests.
//   - "@app/foo"  path-alias (tsconfig paths) -> src/app/foo.ts
//   - "util"      baseUrl top-level (baseUrl "./src") -> src/util.ts
import { foo } from "@app/foo";
import { util } from "util";

export const wired = foo() + util();
