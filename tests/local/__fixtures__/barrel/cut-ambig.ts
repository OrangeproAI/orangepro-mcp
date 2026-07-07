// Genuinely ambiguous barrel for `deep6` (TS2308): one shallow supplier + one
// 7-hop supplier. At the default depth bound the deep branch is CUT, which must
// POISON the collapse (never confirm the shallow terminal alone).
export * from "./impl-deep6.js";
export * from "./deep/l0.js";
