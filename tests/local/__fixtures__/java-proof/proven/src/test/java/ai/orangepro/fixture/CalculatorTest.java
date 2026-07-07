package ai.orangepro.fixture;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CalculatorTest {
    // Asserts the concrete value, so a sentinel that changes the return kills the
    // assertion (proven) while an equivalent-value mutation survives.
    @Test
    void addsTwoNumbers() {
        assertEquals(5, new Calculator().add(2, 3));
    }
}
