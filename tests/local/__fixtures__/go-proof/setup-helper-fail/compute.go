package setuphelperfail

// Compute returns a positive int in the real code. The sentinel replaces its
// body with 0, which fails inside a setup HELPER (t.Helper + t.Fatal) that runs
// before the value-assertion. A helper/setup failure is not a trusted value
// assertion, so the classifier must call this unrunnable, never proven.
func Compute(a, b int) int {
	return a + b
}
