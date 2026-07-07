package ai.orangepro.fixture;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CalculatorTest {
    @Test
    void computesValue() {
        assertEquals((byte) 5, new Calculator().compute());
    }
}
