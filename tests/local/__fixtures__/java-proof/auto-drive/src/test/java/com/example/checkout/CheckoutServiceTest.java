package com.example.checkout;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CheckoutServiceTest {
    // Asserts the concrete value, so the -999 sentinel kills it -> proven.
    @Test
    void createsTotal() {
        assertEquals(5, CheckoutService.createTotal(2, 3));
    }

    // Asserts the value the sentinel also returns (-999), so the mutation is
    // equivalent and the test survives -> no false Proven from an unkillable target.
    @Test
    void loadsEqual() {
        assertEquals(-999, CheckoutService.loadEqual());
    }

    // Asserts createChoice directly (so the analyzer binds the proof edge to it),
    // but its two top-level returns are out of J-1 scope -> mutator refuses ->
    // unrunnable, never proven.
    @Test
    void createsChoice() {
        assertEquals(1, CheckoutService.createChoice(7));
    }
}
