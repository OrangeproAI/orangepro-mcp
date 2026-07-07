package ai.orangepro.fixture;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CalculatorTest {
    // The baseline passes; the point is that the mutator refuses to touch a
    // nested/multiple-return method, so the spike is unrunnable before any mutant.
    @Test
    void classifiesPositive() {
        assertEquals(1, new Calculator().classify(2));
    }
}
