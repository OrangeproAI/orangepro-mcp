package subtestruntime

import "testing"

// TestCompute exercises Compute inside a RUNTIME-named subtest (t.Run(tc.name, ...)),
// exactly like Mattermost's TestFindEndpointForURL. The go-test JSON `Test` field is
// `TestCompute/<runtime>`, so the parent-name exact filter drops the assertion frame —
// Slice 2's --go-assertion-line binds the child failure to the exact assertion line.
//
// Line map (1-based) is load-bearing for the test:
//   line 22 = the Compute assertion `t.Errorf` (TARGET line — mutating Compute fails here)
//   line 35 = the Other/decoy assertion `t.Errorf` (SIBLING line — mutating Compute never fails here)
func TestCompute(t *testing.T) {
	for _, tc := range []struct {
		name        string
		a, b, want  int
	}{
		{name: "adds", a: 2, b: 3, want: 5},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := Compute(tc.a, tc.b); got != tc.want {
				t.Errorf("Compute(%d, %d) = %d, want %d", tc.a, tc.b, got, tc.want)
			}
		})
	}

	for _, tc := range []struct {
		name        string
		a, b, want  int
	}{
		{name: "multiplies", a: 2, b: 3, want: 6},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := Other(tc.a, tc.b); got != tc.want {
				t.Errorf("Other(%d, %d) = %d, want %d", tc.a, tc.b, got, tc.want)
			}
		})
	}
}
