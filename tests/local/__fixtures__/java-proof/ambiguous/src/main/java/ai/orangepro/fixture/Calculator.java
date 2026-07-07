package ai.orangepro.fixture;

/**
 * Two methods named `add` (overloads): name resolution is not exact, so the
 * mutator must REFUSE (ambiguous) rather than mutate a decoy. The spike never
 * reaches a mutant run because the mutation is refused first.
 */
public class Calculator {
    public int add(int a, int b) {
        return a + b;
    }

    public int add(int a, int b, int c) {
        return a + b + c;
    }
}
