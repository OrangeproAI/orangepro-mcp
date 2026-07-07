package ai.orangepro.fixture;

/**
 * `values` returns a reference type (int[]). The J-1 reference sentinel is `null`,
 * so the mutant compiles but the test's `.length` dereference throws a
 * NullPointerException — surfaced by Surefire as a <error>, NOT a <failure>
 * assertion. The classifier must reject a non-assertion throwable as unrunnable,
 * never proven.
 */
public class Calculator {
    public int[] values() {
        return new int[] {1, 2, 3};
    }
}
