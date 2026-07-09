package proven

// Parser is constructed by New; Double is a value method the spike mutates 0->1.
type Parser struct{ n int }

// New is a bare same-package constructor returning *Parser.
func New(n int) *Parser {
	return &Parser{n: n}
}

// Double is the package's UNIQUE method named Double. The sentinel replaces its
// body with a zero-value return, which the value assertion in TestDouble kills.
func (p *Parser) Double() int {
	return p.n * 2
}
