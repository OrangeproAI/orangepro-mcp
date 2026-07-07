package sentinelsurvives

import "testing"

// TestOrigin asserts the zero value, so the zero-return sentinel produces the
// SAME outcome -> the mutation survives (associated_survived), never proven.
func TestOrigin(t *testing.T) {
	if got := Origin(); got != 0 {
		t.Errorf("Origin() = %d, want 0", got)
	}
}
