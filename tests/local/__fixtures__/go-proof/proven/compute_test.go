package proven

import "testing"

// TestCompute asserts the concrete value, so a sentinel that changes the return
// kills the assertion (proven) while an equivalent-value mutation survives.
func TestCompute(t *testing.T) {
	if got := Compute(2, 3); got != 5 {
		t.Errorf("Compute(2, 3) = %d, want 5", got)
	}
}
