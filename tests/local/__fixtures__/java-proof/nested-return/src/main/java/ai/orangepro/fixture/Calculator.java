package ai.orangepro.fixture;

/**
 * `classify` returns a concrete int but its return is NESTED inside an `if` and
 * there is a SECOND return — not the J-1 single-top-level-return shape. FIX 3
 * refuses this at the mutator (out of scope, exit 5), so the spike classifies
 * unrunnable, never proven. The whole-body sentinel is only safe for one exit shape.
 */
public class Calculator {
    public int classify(int a) {
        if (a > 0) {
            return 1;
        }
        return 0;
    }
}
