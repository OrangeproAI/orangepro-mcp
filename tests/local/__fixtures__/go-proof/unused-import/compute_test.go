package proven

import "testing"

// TestCompute asserts the concrete value via the standalone short-var idiom.
func TestCompute(t *testing.T) {
	got := Compute(2, 3)
	if got != "xxxxx" {
		t.Errorf("Compute(2, 3) = %q, want %q", got, "xxxxx")
	}
}
