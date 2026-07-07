//go:build ignore

// go-mutate.go — AST-based body replacer for the Go dynamic-proof spike (G-1).
//
// Locates ONE free function `func Name(params) rets { ... }` by exact name and
// replaces its BODY with a signature-derived sentinel, then writes the mutated
// file. It is a spike helper only: it writes no product artifacts and is not
// wired into prove/RTM/mint. G-1 scope is FREE FUNCTIONS ONLY — methods
// (`func (r Recv) M()`) are recognized and refused as out-of-scope (G-2).
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
//   3  ambiguous: more than one free function with that name
//   4  not found: no free function with that name
//   5  out of scope: a METHOD with that name exists (G-2, refused in G-1)
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
	fn := flag.String("func", "", "exact name of the free function to mutate")
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

	var freeMatches []*ast.FuncDecl
	methodMatch := false
	for _, decl := range astFile.Decls {
		fd, ok := decl.(*ast.FuncDecl)
		if !ok || fd.Name == nil || fd.Name.Name != *fn {
			continue
		}
		if fd.Recv != nil { // method -> out of scope for G-1
			methodMatch = true
			continue
		}
		freeMatches = append(freeMatches, fd)
	}

	if len(freeMatches) > 1 {
		fail(3, "ambiguous: %d free functions named %q", len(freeMatches), *fn)
	}
	if len(freeMatches) == 0 {
		if methodMatch {
			fail(5, "out of scope: %q is a method (G-2); G-1 handles free functions only", *fn)
		}
		fail(4, "not found: no free function named %q", *fn)
	}

	target := freeMatches[0]
	results := target.Type.Results
	if results == nil || len(results.List) == 0 {
		fail(6, "not mutable: %q has no return values; no signature-derived sentinel is possible", *fn)
	}

	if *mode == "sentinel" {
		target.Body = sentinelBody(results)
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
