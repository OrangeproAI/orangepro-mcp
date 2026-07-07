package mutantfatal

import "testing"

// The test has a PRECONDITION guard (t.Fatal) that fires only when Compute
// returns zero. With the real body the precondition is satisfied (5 != 0), the
// test reaches the value-assertion, and passes -> baseline PASSES. With the
// sentinel (returns 0) the precondition t.Fatal aborts the test BEFORE the
// value-assertion ever runs. That is a setup precondition failure, NOT a trusted
// value assertion, so the classifier must call this unrunnable, never proven.
func TestCompute(t *testing.T) {
	result := Compute(2, 3)
	if result == 0 {
		t.Fatal("precondition failed: compute produced an unusable zero result")
	}
	if result != 5 {
		t.Errorf("Compute(2, 3) = %d, want 5", result)
	}
}
