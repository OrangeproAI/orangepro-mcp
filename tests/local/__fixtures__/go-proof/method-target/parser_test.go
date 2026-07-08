package proven

import "testing"

// TestDouble binds to Parser.Double via p := New(...) (a bare same-package
// constructor) then p.Double(), asserting the concrete value.
func TestDouble(t *testing.T) {
	p := New(3)
	if got := p.Double(); got != 6 {
		t.Errorf("Double() = %d, want 6", got)
	}
}
