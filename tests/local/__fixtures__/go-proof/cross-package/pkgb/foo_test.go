package pkgb

import "testing"

// SAME test name (TestName) AND same file basename (foo_test.go) as pkga's test,
// with the failing t.Errorf on the SAME source line (13) as pkga's assertion.
// This is the worst case for the old `go test ./...` + name-only `-run` design:
// pkgb's cross-package failure reports `foo_test.go:13`, whose basename collides
// with pkga's test file, so the source-line binding resolves against pkga's
// assertion line and (under the old scope) MINTS A FALSE PROVEN for pkga's Foo.
func TestName(t *testing.T) {
	if got := Bar(); got != 5 {
		t.Errorf("Bar() = %d, want 5", got)
	}
}
