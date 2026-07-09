package pair

import "testing"

// TestAM asserts A's M only — a mutation of B.M leaves it passing (survived),
// so crediting B via this test would be a false Proven.
func TestAM(t *testing.T) {
	a := NewA(1)
	if got := a.M(); got != 2 {
		t.Errorf("M() = %d, want 2", got)
	}
}
