package ai.orangepro.fixture;

import org.junit.jupiter.api.Test;

class CalculatorTest {
    // Does NOT call assertEquals / assertThat. It hand-checks and throws a bare
    // java.lang.AssertionError directly, so the <failure> stack's top frame is this
    // test class, with no org.junit./org.opentest4j./org.hamcrest./org.assertj. frame.
    // With the real body it passes; under the sentinel it throws AssertionError — but
    // that is NOT a trusted assertion-API signal, so FIX 2 rejects it.
    @Test
    void addsTwoNumbers() {
        int actual = new Calculator().add(2, 3);
        if (actual != 5) {
            throw new AssertionError("expected 5 but was " + actual);
        }
    }
}
