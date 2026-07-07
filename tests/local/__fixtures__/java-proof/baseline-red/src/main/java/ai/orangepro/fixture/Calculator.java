package ai.orangepro.fixture;

/**
 * `add` is a perfectly provable simplest shape and the target testcase PASSES, but
 * the test class's @AfterAll teardown throws, so `mvn` exits NONZERO — the run is
 * red. FIX 1 requires baseline mvn exit 0 (not just a passing target testcase), so a
 * red build is not a clean baseline and this classifies unrunnable, never proven.
 */
public class Calculator {
    public int add(int a, int b) {
        return a + b;
    }
}
