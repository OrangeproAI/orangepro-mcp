package ai.orangepro.fixture;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class ConstantTest {
    // Asserts the value the sentinel also produces (-999), so the sentinel mutation
    // yields the SAME outcome -> the mutation survives (associated_survived), never
    // proven. This is the mint-path no-false-Proven guard.
    @Test
    void returnsConstant() {
        assertEquals(-999, new Constant().value());
    }
}
