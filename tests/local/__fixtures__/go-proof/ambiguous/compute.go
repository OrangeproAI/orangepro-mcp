package ambiguous

// Two free functions named Compute in the same file: name resolution is not
// exact, so the mutator must REFUSE (ambiguous) rather than mutate a decoy.
// (This package does not compile on its own; the spike never reaches a mutant
// run because the mutation is refused first.)

func Compute(a, b int) int {
	return a + b
}

func Compute(a, b, c int) int {
	return a + b + c
}
