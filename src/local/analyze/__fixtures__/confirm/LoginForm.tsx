// A component subject for P2: a JSX render + assertion should CONFIRM coverage
// of LoginForm (the runtime use is the JSX element — conjunct 3's render path).
// No explicit return-type annotation so the fixture parses without React/JSX
// typings present (the confirmer resolves the tag identity, not the JSX type).
export function LoginForm() {
  return (
    <form>
      <label htmlFor="email">Email</label>
      <input id="email" name="email" />
      <button type="submit">Sign in</button>
    </form>
  );
}

// A second component used by N40 (multiple renders in one block → ambiguous effect).
export function OtherForm() {
  return <div>other</div>;
}
