package ai.orangepro.fixture;

/**
 * `compute` returns `byte`. The J-1 integral sentinel is `-999`, which does NOT
 * fit in a byte, so the mutant fails to COMPILE ("possible lossy conversion from
 * int to byte"). The classifier must treat a mutant compile failure as
 * unrunnable, never proven — even though the real code compiled and passed.
 */
public class Calculator {
    public byte compute() {
        return (byte) 5;
    }
}
