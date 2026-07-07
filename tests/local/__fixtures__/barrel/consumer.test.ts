// Consumer used by the barrel_terminal gate-metric test (role: test).
import { saveUser, deleteUser } from "./index.js"; // barrel; both reach terminals -> resolved
import { dup } from "./ambig/index.js"; // barrel; ambiguous (two stars) -> NOT walked
import { fetchData } from "./more.js"; // NOT a barrel -> excluded from the denom
import * as everything from "./index.js"; // namespace import -> excluded from the denom

export const wired = [saveUser, deleteUser, dup, fetchData, everything];
