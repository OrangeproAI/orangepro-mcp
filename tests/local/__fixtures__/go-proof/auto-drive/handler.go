package checkout

// CreateTotal is an entrypoint-adjacent FREE function (handler/service-like name and
// file). A zero-value sentinel (`return 0`) changes its result, so the asserting test
// fails under mutation -> Dynamically Proven.
func CreateTotal(a, b int) int {
	return a + b
}

// LoadZero is entrypoint-adjacent but returns 0, which equals the Go zero-value
// sentinel -> an equivalent mutation the test cannot distinguish -> survives (unproven).
func LoadZero() int {
	return 0
}

// Cart is a receiver type so ProcessCart is a METHOD, not a free function. Methods
// enter auto-drive only via a hard receiver-local TESTED_BY edge; TestProcessCart
// builds its receiver from a composite literal (no bare constructor), so no such
// edge is minted and auto-drive excludes ProcessCart at selection.
type Cart struct{ items int }

// ProcessCart has a behavior-surface-like name but is a method -> excluded.
func (c Cart) ProcessCart() int {
	return c.items + 1
}
