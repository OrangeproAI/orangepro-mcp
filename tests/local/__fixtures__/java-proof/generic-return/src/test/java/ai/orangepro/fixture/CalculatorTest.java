package ai.orangepro.fixture;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CalculatorTest {
    // The baseline passes; the point is that the mutator refuses a type-variable
    // return type, so the spike is unrunnable before any mutant.
    @Test
    void returnsTheValue() {
        assertEquals("hello", new Calculator<>("hello").identity());
    }
}
