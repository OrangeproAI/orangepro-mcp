package sentinelsurvives

// Origin is a free function whose real return value is the zero value, so the
// dynamic-proof zero-return SENTINEL is equivalent to the real body: the mutant
// still passes the test -> associated_survived (a NO-false-Proven guard for the
// mint path, which always mutates in sentinel mode).
func Origin() int {
	return 0
}
