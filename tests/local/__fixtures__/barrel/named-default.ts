// Explicit named re-export DOES forward a default (stays COVERS-eligible),
// unlike `export *`.
export { default as RealDefault } from "./def-default.js";
