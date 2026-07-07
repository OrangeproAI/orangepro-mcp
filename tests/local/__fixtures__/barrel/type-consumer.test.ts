// A RUNTIME import (not `import type`) of a TYPE name through a barrel must NOT
// count toward barrel_terminal; the sibling runtime import must.
import { realFn } from "./runtime-star-to-type.js"; // runtime -> covered
import { Model } from "./runtime-star-to-type.js"; // type -> NOT covered

export const wired = [realFn, Model];
