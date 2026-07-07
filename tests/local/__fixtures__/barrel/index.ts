// Barrel: a star re-export + a named re-export + a renamed (aliased) re-export.
// All specifiers are NodeNext ".js" so the walker also exercises the .js->.ts rewrite.
export * from "./defs.js";
export { fetchData } from "./more.js";
export { saveUser as storeUser } from "./defs.js";
