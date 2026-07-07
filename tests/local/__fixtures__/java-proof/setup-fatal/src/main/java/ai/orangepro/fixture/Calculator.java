package ai.orangepro.fixture;

/**
 * `add` is a perfectly provable simplest shape, but the test's @BeforeEach throws
 * BEFORE the target is ever exercised, so the target test fails in the BASELINE
 * (independent of any mutant). The classifier requires the baseline target test to
 * pass, so this is unrunnable (a setup precondition, not an assertion signal).
 */
public class Calculator {
    public int add(int a, int b) {
        return a + b;
    }
}
