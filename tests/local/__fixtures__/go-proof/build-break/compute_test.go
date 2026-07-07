package buildbreak

import "testing"

func TestCompute(t *testing.T) {
	if got := Compute(2, 3); got != "5" {
		t.Errorf("Compute(2, 3) = %q, want \"5\"", got)
	}
}
