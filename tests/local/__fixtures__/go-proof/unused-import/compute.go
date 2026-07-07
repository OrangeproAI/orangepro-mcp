package proven

import "strings"

// Compute uses an import ONLY inside the target body — the sentinel mutation
// orphans it, so the mutant compiles only if the mutator blanks the import.
func Compute(a, b int) string {
	return strings.Repeat("x", a+b)
}
