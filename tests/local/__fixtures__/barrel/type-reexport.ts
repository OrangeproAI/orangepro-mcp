// `export type { ... } from` -> a type-only hop. Even a RUNTIME terminal reached
// through it is NOT COVERS-eligible (consumers get only the type side).
export type { Model, realFn } from "./types.js";
