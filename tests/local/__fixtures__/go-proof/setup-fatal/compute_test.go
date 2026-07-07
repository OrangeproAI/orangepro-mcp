package setupfatal

import "testing"

// A precondition t.Fatal fires BEFORE the target is ever called, so the test
// fails in the BASELINE (independent of any mutant). The classifier requires the
// baseline target test to pass, so this is unrunnable (setup, not assertion).
func TestCompute(t *testing.T) {
	if databaseUnavailable() {
		t.Fatal("precondition failed: test database is unavailable")
	}
	if got := Compute(2, 3); got != 5 {
		t.Errorf("Compute(2, 3) = %d, want 5", got)
	}
}

func databaseUnavailable() bool {
	return true
}
