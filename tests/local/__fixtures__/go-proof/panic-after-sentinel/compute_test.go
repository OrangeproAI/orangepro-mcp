package panicafter

import "testing"

// The test indexes the returned slice. With the real body it holds one element
// (passes); with the nil-slice sentinel, result[0] panics with an index-out-of-
// range runtime error — a panic, not a test assertion.
func TestCompute(t *testing.T) {
	result := Compute(2, 3)
	if result[0] != 5 {
		t.Errorf("Compute(2, 3)[0] = %d, want 5", result[0])
	}
}
