package pkga

// Foo is the mutation TARGET. Its real value is 5; the sentinel makes it return
// the zero value 0. pkga's OWN test (TestName in foo_test.go) tolerates that
// change, so from the target package's view the mutation SURVIVES (equivalent).
func Foo() int {
	return 5
}
