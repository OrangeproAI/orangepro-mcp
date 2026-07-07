package ai.orangepro.fixture;

/**
 * `identity` returns the enclosing class's type variable `T` (a single top-level
 * return, no method-level `<T>`). Its return type is a type VARIABLE, so no
 * type-derived sentinel is safe — the runtime type is unknown. FIX 3 refuses this at
 * the mutator (out of scope, exit 5) via the type-variable-return check, so the
 * spike classifies unrunnable, never proven. (The old method-`<T>`-only generic
 * check missed this class-level type-variable return.)
 */
public class Calculator<T> {
    private final T value;

    public Calculator(T value) {
        this.value = value;
    }

    public T identity() {
        return value;
    }
}
