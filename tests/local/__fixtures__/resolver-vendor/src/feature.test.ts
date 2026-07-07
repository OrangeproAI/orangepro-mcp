// Vendor-alias fixture test. Read from disk by the resolver tests.
//   - "@app/foo"    path-alias -> src/app/foo.ts        (workspace-internal)
//   - "@vendor/ui"  path-alias -> node_modules/@vendor/ui (vendor shim: must
//                    leave the workspace_package DENOMINATOR entirely)
import { foo } from "@app/foo";
import { Button } from "@vendor/ui";

export const wired = foo() + Button().length;
