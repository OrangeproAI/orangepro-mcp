// DECOY source of @wspkg/b. The package's runtime entry is BUILT output (dist/index.js), so aspect-2
// must copy + alias dist, NOT this source. base=999 here would break the built-output assertion if the
// entry were ever mis-resolved to source — proving the built-vs-source preference.
export const base = 999;
