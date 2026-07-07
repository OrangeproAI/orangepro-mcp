package buildbreak

import "strconv"

// Compute is the ONLY user of strconv in this file. The sentinel replaces its
// body, dropping that usage, so the mutant fails to compile ("imported and not
// used"). The classifier must treat a mutant build failure as unrunnable, never
// proven.
func Compute(a, b int) string {
	return strconv.Itoa(a + b)
}
