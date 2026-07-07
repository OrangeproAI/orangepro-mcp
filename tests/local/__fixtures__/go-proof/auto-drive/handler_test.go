package checkout

import "testing"

// TestCreateTotal asserts the concrete value, so a zero-value sentinel kills it (proven).
func TestCreateTotal(t *testing.T) {
	if got := CreateTotal(2, 3); got != 5 {
		t.Errorf("CreateTotal(2, 3) = %d, want 5", got)
	}
}

// TestLoadZero asserts the value the zero-value sentinel also returns, so the mutation
// is equivalent and the test survives (no false Proven from an unkillable target).
func TestLoadZero(t *testing.T) {
	if got := LoadZero(); got != 0 {
		t.Errorf("LoadZero() = %d, want 0", got)
	}
}

// TestProcessCart exercises the method target (which auto-drive excludes at selection).
func TestProcessCart(t *testing.T) {
	c := Cart{items: 1}
	if got := c.ProcessCart(); got != 2 {
		t.Errorf("ProcessCart() = %d, want 2", got)
	}
}
