package buildbreak

import . "strconv"

// Compute is the ONLY user of strconv here, DOT-imported. The sentinel replaces
// its body, dropping that usage. The mutator's blank-import repair deliberately
// does NOT touch dot imports (a dot import has no qualifier to blank), so the
// mutant still fails to compile ("imported and not used"). This guards the
// repair's SCOPE: only regular orphaned imports are repaired — a genuine mutant
// build failure must stay unrunnable, never proven.
func Compute(a, b int) string {
	return Itoa(a + b)
}
