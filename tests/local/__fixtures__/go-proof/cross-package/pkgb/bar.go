package pkgb

import "example.com/crosspkg/pkga"

// Bar forwards pkga.Foo, so mutating Foo changes Bar's value too.
func Bar() int {
	return pkga.Foo()
}
