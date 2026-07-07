// N12 top-level-unrelated-assert: a runtime call and an assertion both at MODULE
// TOP LEVEL (outside any it()/test() callback), asserting unrelated things.
// Fails conjunct 5 (the runtime use is in no test block, so an unrelated
// top-level assertion can never accompany it). Expected: INFERRED — pins the
// false-confirm the old source-file-fallback "block" allowed.
import { saveUser } from "./impl.js";
declare const expect: (v: unknown) => { toBe(x: unknown): void };

saveUser({ id: "u1" });
expect(2 + 2).toBe(4);
