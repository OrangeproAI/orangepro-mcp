package ai.orangepro.fixture;

/**
 * `add` is a provable simplest shape, but the test does NOT use a trusted assertion
 * API: it hand-checks the value and does `throw new AssertionError(...)` itself. The
 * mutant's <failure> is therefore a bare java.lang.AssertionError whose top stack
 * frame is the TEST CLASS, not org.junit./org.opentest4j./org.hamcrest./org.assertj.
 * FIX 2 requires a bare AssertionError to be attributable to a trusted assertion API
 * via its stack trace, so this classifies unrunnable, never proven.
 */
public class Calculator {
    public int add(int a, int b) {
        return a + b;
    }
}
