// One star is unexpandable (unresolvable package) — it could supply ANY name,
// so no binding through this barrel may be confirmed via the other star.
export * from "nonexistent-pkg-zz";
export * from "./defs.js";
