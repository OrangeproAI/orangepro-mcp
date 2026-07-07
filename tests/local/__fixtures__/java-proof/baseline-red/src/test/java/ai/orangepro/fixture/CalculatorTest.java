package ai.orangepro.fixture;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;

class CalculatorTest {
    // The target testcase PASSES on its own.
    @Test
    void addsTwoNumbers() {
        assertEquals(5, new Calculator().add(2, 3));
    }

    // A container-level teardown that throws AFTER the target testcase has already
    // recorded a PASS. Surefire keeps the target <testcase> passed, but `mvn` exits
    // NONZERO (the run is red). FIX 1 rejects a red baseline as unrunnable.
    @AfterAll
    static void tearDownFails() {
        throw new IllegalStateException("teardown blew up after tests ran");
    }
}
