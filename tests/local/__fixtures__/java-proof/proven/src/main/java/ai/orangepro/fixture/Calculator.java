package ai.orangepro.fixture;

/**
 * Calculator is the class the Java dynamic-proof spike mutates 0->1. `add` is the
 * simplest shape: a concrete non-void return, a single top-level return, no
 * generics, no overloads.
 */
public class Calculator {
    // The sentinel replaces this body with `{ return -999; }`. A value-asserting
    // test then fails (proven); an equivalent-value mutation survives.
    public int add(int a, int b) {
        return a + b;
    }
}
