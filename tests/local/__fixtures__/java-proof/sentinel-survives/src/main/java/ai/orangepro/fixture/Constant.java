package ai.orangepro.fixture;

/**
 * Constant is the no-false-Proven guard for the Java mint path (which always mutates
 * in sentinel mode). `value` returns the SAME int the type-derived sentinel produces
 * (-999), so the sentinel mutation is equivalent to the real body: the mutant still
 * passes the test -> associated_survived, never proven.
 */
public class Constant {
    // The int sentinel is `-999` (java-mutate.mjs). Returning that value makes the
    // sentinel mutation equivalent, so a value-asserting test still passes.
    public int value() {
        return -999;
    }
}
