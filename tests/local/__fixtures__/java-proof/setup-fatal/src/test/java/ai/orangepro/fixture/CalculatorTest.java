package ai.orangepro.fixture;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class CalculatorTest {
    // A precondition that throws BEFORE the target test body runs. Surefire records
    // the target testcase as failing due to setup, so the baseline never passes and
    // the spike classifies unrunnable — not a mutation-derived assertion signal.
    @BeforeEach
    void requireDatabase() {
        throw new IllegalStateException("precondition failed: test database is unavailable");
    }

    @Test
    void addsTwoNumbers() {
        assertEquals(5, new Calculator().add(2, 3));
    }
}
