package setuphelperfail

import "testing"

// mustBeUsable is a setup HELPER (t.Helper marks it so failures are attributed to
// the caller line). It aborts the test with t.Fatal when the value is unusable.
// With the real body the value is usable; with the sentinel (0) the helper aborts
// the test BEFORE the value-assertion runs.
func mustBeUsable(t *testing.T, v int) {
	t.Helper()
	if v == 0 {
		t.Fatal("setup helper: computed value is unusable")
	}
}

// TestCompute runs the setup helper first, then the value-assertion. Baseline:
// helper passes, value-assertion passes -> PASS. Mutant: the helper's t.Fatal
// aborts the test -> a setup/helper failure, NOT a trusted value assertion ->
// unrunnable, never proven.
func TestCompute(t *testing.T) {
	result := Compute(2, 3)
	mustBeUsable(t, result)
	if result != 5 {
		t.Errorf("Compute(2, 3) = %d, want 5", result)
	}
}
