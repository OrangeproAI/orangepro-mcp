// `export { x }` (no `from`) of an IMPORTED binding -> the walker must FOLLOW
// the import to the terminal (./defs.ts), not stop here.
import { saveUser } from "./defs.js";
export { saveUser };
