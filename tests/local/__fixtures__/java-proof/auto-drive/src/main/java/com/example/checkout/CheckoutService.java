package com.example.checkout;

/**
 * Entry-point-adjacent (Service-owner + create/load names) statics for the Java
 * auto-drive integration. Each is a J-1 candidate the analyzer marks
 * denominator_eligible + entrypoint_adjacent, so `opro start` (autoProve) selects
 * them with NO explicit test_run.
 */
public class CheckoutService {
    // Proven: a concrete int return the sentinel (-999) changes, asserted on its
    // concrete value -> the mutated test fails -> Dynamically Proven.
    public static int createTotal(int a, int b) {
        return a + b;
    }

    // Equivalent survivor: returns exactly the int sentinel (-999) the mutator
    // splices in, so the mutation is value-equivalent and the asserting test still
    // passes -> associated_survived -> never a false Proven.
    public static int loadEqual() {
        return -999;
    }

    // Refused shape: two top-level returns are out of J-1 scope (the sentinel
    // replaces the WHOLE body), so the Java mutator refuses it -> unrunnable ->
    // never Proven, even though the test asserts on it directly (so it IS selected
    // + attempted, then classified unrunnable rather than proven).
    public static int createChoice(int x) {
        if (x > 0) {
            return 1;
        }
        return 0;
    }
}
