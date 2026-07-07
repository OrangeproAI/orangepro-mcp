package mutantfatalfgotwant

import "testing"

// The test has a PRECONDITION guard that uses t.Fatalf with a "got .. want"
// message. With the real body the precondition holds (5 != 0) and the test
// reaches the value-assertion and passes -> baseline PASSES. With the sentinel
// (returns 0) the t.Fatalf precondition aborts the test BEFORE the value-
// assertion. The message text contains "got"/"want", which the old TEXT heuristic
// wrongly trusted (Codex-reproduced false Proven). SOURCE-LINE BINDING reads the
// failing line back: it is a t.Fatalf hard-stop, NOT an assertion -> unrunnable.
func TestCompute(t *testing.T) {
	got := Compute(2, 3)
	if got == 0 {
		t.Fatalf("precondition: got %v, want %v", got, 5)
	}
	if got != 5 {
		t.Errorf("Compute(2, 3) = %d, want 5", got)
	}
}
