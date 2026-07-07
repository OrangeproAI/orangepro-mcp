package broadrun

// Compute returns a non-negative int. The sentinel replaces its body with 0,
// which the target test tolerates (it asserts >= 0), so the TARGET test PASSES
// under the mutant. The proof must NOT come from an unrelated failing test.
func Compute(a, b int) int {
	return a + b
}
