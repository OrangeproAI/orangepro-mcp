package mutantfatal

// Compute returns a positive int in the real code. The sentinel replaces its
// body with 0, which trips a t.Fatal PRECONDITION in the test (see compute_test)
// BEFORE the value-assertion runs. A precondition abort is not a trusted value
// assertion, so the classifier must call this unrunnable, never proven.
func Compute(a, b int) int {
	return a + b
}
