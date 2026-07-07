package pkga

import "testing"

// TestName in the TARGET's package asserts only a LOOSE property (Foo() >= 0), so
// it passes at baseline (5) AND survives the sentinel (0). The target package's
// own test therefore does NOT catch the mutation -> the correct verdict is
// associated_survived, NEVER proven. A same-named TestName in pkgb DOES catch the
// mutation, but that failure belongs to a different package and must never be
// credited to Foo.
func TestName(t *testing.T) {
	if got := Foo(); got < 0 {
		t.Errorf("Foo() = %d, want >= 0", got)
	}
}
