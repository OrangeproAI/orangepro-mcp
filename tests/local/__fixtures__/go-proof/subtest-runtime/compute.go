package subtestruntime

// Compute is the TARGET. Its assertion lives in a runtime-named subtest.
func Compute(a, b int) int {
	return a + b
}

// Other is a DECOY asserted by a sibling subtest at a different line — mutating
// Compute must never be credited to Other's assertion line.
func Other(a, b int) int {
	return a * b
}
