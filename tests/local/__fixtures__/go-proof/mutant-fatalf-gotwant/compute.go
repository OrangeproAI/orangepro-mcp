package mutantfatalfgotwant

// Compute returns a positive int in the real code. The sentinel replaces its
// body with 0, which trips a t.Fatalf PRECONDITION whose free-text message
// happens to contain "got .. want" (see compute_test) BEFORE the value-assertion
// runs. The old TEXT heuristic read that "got/want" text as a trusted assertion
// (false Proven); SOURCE-LINE BINDING reads the failing line back in the test
// source, sees it is a t.Fatalf hard-stop, and classifies this unrunnable.
func Compute(a, b int) int {
	return a + b
}
