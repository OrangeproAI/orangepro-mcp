package panicafter

// Compute returns a non-empty slice. The sentinel replaces its body with a nil
// slice, so the test's index access panics (runtime error) rather than failing an
// assertion. The classifier must treat a panic as unrunnable, never proven.
func Compute(a, b int) []int {
	return []int{a + b}
}
