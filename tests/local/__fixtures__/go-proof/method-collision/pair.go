package pair

// A and B deliberately declare the SAME method name M — the in-file collision
// the receiver-exact --recv selection must disambiguate without ever mutating
// the wrong declaration.
type A struct{ n int }
type B struct{ n int }

// NewA is a bare same-package constructor for A (the receiver-local shape).
func NewA(n int) *A { return &A{n: n} }

// NewB is a bare same-package constructor for B.
func NewB(n int) *B { return &B{n: n} }

// M on A returns n+1; the zero-value sentinel (0) kills TestAM's assertion.
func (a *A) M() int { return a.n + 1 }

// M on B returns n+2; mutating it must never fail TestAM (which exercises A only).
func (b *B) M() int { return b.n + 2 }
