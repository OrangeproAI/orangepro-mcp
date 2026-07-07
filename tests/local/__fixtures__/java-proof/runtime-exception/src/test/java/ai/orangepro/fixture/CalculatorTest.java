package ai.orangepro.fixture;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CalculatorTest {
    // Dereferences the returned array. With the real body it has length 3
    // (passes); with the null sentinel, `.length` throws NullPointerException —
    // a runtime error, not a test assertion.
    @Test
    void hasThreeValues() {
        assertEquals(3, new Calculator().values().length);
    }
}
