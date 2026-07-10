//go:build ignore

// go-mutate.go — AST-based body replacer for the Go dynamic-proof spike (G-1).
//
// Locates ONE function declaration by exact name — a free function `func Name(...)`
// or a receiver method `func (r Recv) Name(...)` — and replaces its BODY with a
// signature-derived sentinel, then writes the mutated file. Invoked by
// go-dynamic-proof-spike.mjs (the product Go proof path); it writes ONLY the
// mutated file inside the sandbox copy — no graph or product artifacts. The
// name must resolve to exactly ONE declaration — in the whole file without
// --recv, or on the selected base receiver with --recv <T> (receiver-exact
// selection for receiver-qualified `Recv.M` targets — never the wrong decl,
// so A.M and B.M can coexist and still be individually mutable). Ambiguity
// within that filter fails(3); generic receivers are refused (not found).
//
// Modes:
//   sentinel   — replace body with a type-compatible, deliberately-wrong value
//                (zero values). Zero-valued returns can only ever cause a FALSE
//                SURVIVE, never a false Proven, so the trust bias is safe.
//   equivalent — leave the body semantically unchanged (re-print identical
//                statements) so a value-only test still passes -> the
//                orchestrator classifies it associated_survived.
//
// Exit codes (distinct, so the Node orchestrator can classify precisely):
//   0  ok, mutated file written
//   2  usage / IO / parse error
//   3  ambiguous: more than one declaration (free and/or method) with that name
//   4  not found: no free function or method with that name
//   5  RETIRED — was "method out of scope (G-2)" before methods became mutable;
//      no longer emitted (kept so codes 3/4/6 stay stable for the orchestrator)
//   6  not mutable: the function has no return values (no signature-derived
//      sentinel is possible) -> fail closed, never mutated
package main

import (
	"bytes"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"strings"
)

// fail prints a stable, machine-readable marker plus a human message and exits
// with the given code. The marker matters because callers run this via
// `go run`, which collapses any non-zero child status to 1 — so the Node
// orchestrator classifies on the MUTATE_ERROR:<code> line, not the exit code.
// The distinct os.Exit code is still set for direct (compiled) callers.
func fail(code int, format string, args ...any) {
	fmt.Fprintf(os.Stderr, "MUTATE_ERROR:%d\n", code)
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(code)
}

func main() {
	file := flag.String("file", "", "path to the Go source file to mutate")
	fn := flag.String("func", "", "exact name of the free function or method to mutate")
	recv := flag.String("recv", "", "receiver base type name; when set, match only methods on this receiver")
	out := flag.String("out", "", "path to write the mutated file (defaults to --file)")
	mode := flag.String("mode", "sentinel", "sentinel | equivalent")
	flag.Parse()

	if *file == "" || *fn == "" {
		fail(2, "usage: go run go-mutate.go --file <path> --func <name> [--out <path>] [--mode sentinel|equivalent]")
	}
	if *mode != "sentinel" && *mode != "equivalent" {
		fail(2, "--mode must be sentinel or equivalent")
	}
	dst := *out
	if dst == "" {
		dst = *file
	}

	fset := token.NewFileSet()
	astFile, err := parser.ParseFile(fset, *file, nil, parser.ParseComments)
	if err != nil {
		fail(2, "parse error: %v", err)
	}

	// Collect BOTH free functions and methods named *fn. The proof lane only ever
	// targets a method whose name is UNIQUE in its package (the analyzer's
	// uniqueGoPackageSymbol refuses cross-file collisions before an edge is minted);
	// this file-scoped count is the in-file backstop, so free+method or two-method
	// collisions fail(3) as ambiguous — never a mislabeled mutation. A lone decl
	// (free OR method) is mutated identically via the receiver-agnostic sentinel.
	var matches []*ast.FuncDecl
	for _, decl := range astFile.Decls {
		fd, ok := decl.(*ast.FuncDecl)
		if !ok || fd.Name == nil || fd.Name.Name != *fn {
			continue
		}
		// Refuse generic receivers (r T[U]) — receiver base type is not a bare Ident.
		if fd.Recv != nil && recvBaseIdent(fd) == nil {
			continue
		}
		// Receiver-exact selection: when --recv is set, only a method on that base
		// receiver type matches — a free function or another receiver never can, so
		// a receiver-qualified target can never mutate the wrong declaration.
		if *recv != "" {
			if fd.Recv == nil {
				continue
			}
			if id := recvBaseIdent(fd); id == nil || id.Name != *recv {
				continue
			}
		}
		matches = append(matches, fd)
	}

	if len(matches) > 1 {
		fail(3, "ambiguous: %d declarations named %q (free and/or methods)", len(matches), *fn)
	}
	if len(matches) == 0 {
		if *recv != "" {
			fail(4, "not found: no method named %q on receiver %q", *fn, *recv)
		}
		fail(4, "not found: no free function or method named %q", *fn)
	}

	target := matches[0]
	results := target.Type.Results
	if results == nil || len(results.List) == 0 {
		fail(6, "not mutable: %q has no return values; no signature-derived sentinel is possible", *fn)
	}

	if *mode == "sentinel" {
		target.Body = sentinelBody(results)
		// The sentinel body can orphan imports the original body used (Go
		// rejects unused imports, so the mutant would fail to BUILD and the
		// oracle would refuse — an honest but useless verdict for most real
		// functions). Rewrite now-unused imports to blank imports: package
		// init side effects are preserved, no behavior is added, and the
		// repair is fail-safe in both directions — over-blanking a used
		// import still fails the build (refusal, never proof), and a missed
		// unused import is exactly today's behavior.
		blankUnusedImports(astFile)
	}
	// equivalent mode: leave target.Body untouched (semantically identical).

	var buf bytes.Buffer
	cfg := printer.Config{Mode: printer.UseSpaces | printer.TabIndent, Tabwidth: 8}
	if err := cfg.Fprint(&buf, fset, astFile); err != nil {
		fail(2, "print error: %v", err)
	}
	if err := os.WriteFile(dst, buf.Bytes(), 0o644); err != nil {
		fail(2, "write error: %v", err)
	}
}

// blankUnusedImports renames imports whose package qualifier is no longer
// referenced anywhere in the file to blank imports (`_ "path"`). Dot imports
// and existing blank imports are left untouched. Qualifier detection is
// syntactic (selector bases), which over-approximates "used" — the safe
// direction: we only ever blank an import nothing references.
func blankUnusedImports(f *ast.File) {
	used := map[string]bool{}
	ast.Inspect(f, func(n ast.Node) bool {
		if sel, ok := n.(*ast.SelectorExpr); ok {
			if id, ok := sel.X.(*ast.Ident); ok {
				used[id.Name] = true
			}
		}
		return true
	})
	for _, imp := range f.Imports {
		if imp.Name != nil {
			if imp.Name.Name == "_" || imp.Name.Name == "." {
				continue
			}
			if !used[imp.Name.Name] {
				imp.Name = ast.NewIdent("_")
			}
			continue
		}
		path := strings.Trim(imp.Path.Value, "\"")
		base := path[strings.LastIndex(path, "/")+1:]
		if !used[base] {
			imp.Name = ast.NewIdent("_")
		}
	}
}

// recvBaseIdent returns the receiver type's base identifier for a method decl
// (unwrapping a pointer receiver `*T` to `T`), or nil for a generic/unsupported
// receiver. Used only to refuse generic receivers; value-vs-pointer is irrelevant
// to body mutation (Go auto-(de)refs at the call site).
func recvBaseIdent(fd *ast.FuncDecl) *ast.Ident {
	if fd.Recv == nil || len(fd.Recv.List) != 1 {
		return nil
	}
	t := fd.Recv.List[0].Type
	if star, ok := t.(*ast.StarExpr); ok {
		t = star.X
	}
	id, _ := t.(*ast.Ident)
	return id
}

// sentinelBody builds `{ return <zero>, <zero>, ... }` matching the function's
// result signature so the mutant COMPILES. Zero values are type-derived and
// deliberately wrong for any function whose real return is non-zero; when a
// function legitimately returns a zero value the sentinel merely SURVIVES
// (safe: never a false Proven).
func sentinelBody(results *ast.FieldList) *ast.BlockStmt {
	var exprs []ast.Expr
	for _, field := range results.List {
		n := len(field.Names)
		if n == 0 {
			n = 1 // an unnamed result still contributes one value
		}
		for i := 0; i < n; i++ {
			exprs = append(exprs, zeroValue(field.Type))
		}
	}
	return &ast.BlockStmt{
		List: []ast.Stmt{
			&ast.ReturnStmt{Results: exprs},
		},
	}
}

// zeroValue returns an expression that is the zero value of the given type.
// It covers the common cases; anything it cannot name concretely falls back to
// a type-conversion of nil-like zero via a composite/`*new(T)` form that always
// compiles.
func zeroValue(t ast.Expr) ast.Expr {
	switch tt := t.(type) {
	case *ast.Ident:
		switch tt.Name {
		case "int", "int8", "int16", "int32", "int64",
			"uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
			"byte", "rune", "float32", "float64", "complex64", "complex128":
			return &ast.BasicLit{Kind: token.INT, Value: "0"}
		case "string":
			return &ast.BasicLit{Kind: token.STRING, Value: `""`}
		case "bool":
			return ast.NewIdent("false")
		case "error", "any":
			return ast.NewIdent("nil")
		default:
			// A named type (struct/interface alias). *new(T) is the universal
			// zero value that always compiles.
			return newZero(tt)
		}
	case *ast.StarExpr, *ast.ArrayType, *ast.MapType, *ast.ChanType,
		*ast.FuncType, *ast.InterfaceType:
		return ast.NewIdent("nil")
	default:
		return newZero(t)
	}
}

// newZero produces `*new(T)` — a universal, always-compiling zero value.
func newZero(t ast.Expr) ast.Expr {
	return &ast.StarExpr{
		X: &ast.CallExpr{
			Fun:  ast.NewIdent("new"),
			Args: []ast.Expr{t},
		},
	}
}
