package broadrun

import "testing"

// TestCompute tolerates the sentinel: it asserts only that the result is
// non-negative, and the sentinel (return 0) still satisfies that. So the TARGET
// test PASSES under the mutant.
func TestCompute(t *testing.T) {
	if got := Compute(2, 3); got < 0 {
		t.Errorf("Compute(2, 3) = %d, want >= 0", got)
	}
}

// TestUnrelated ALWAYS fails and has nothing to do with Compute. A broad
// --test-run (e.g. `Compute` unanchored, or `^Test`) would match BOTH tests; if
// the classifier fell back to match-any it could read this unrelated failure as
// the proof. FIX 1 rejects the broad pattern as unrunnable instead.
func TestUnrelated(t *testing.T) {
	t.Errorf("unrelated assertion always fails")
}
