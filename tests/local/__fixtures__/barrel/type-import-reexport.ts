// `realFn` is a RUNTIME function in types.ts, but imported type-only here, then
// re-exported. TS elides it at runtime, so this re-export is type-only and must
// NOT be COVERS-eligible (covered:false), even though the terminal def is runtime.
import type { realFn } from "./types.js";
export { realFn };
