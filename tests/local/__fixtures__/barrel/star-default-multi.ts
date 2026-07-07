// Two stars; only def-default has a default. A star still never forwards a default,
// so walking "default" here must be unresolved (not the def-default default).
export * from "./plain.js";
export * from "./def-default.js";
