# Sample requirements

Small, illustrative requirements for the OrangePro Local Proof Kit score-lift demo.
Point `analyze` at this file (copied into the repo you are scanning) to see the
readiness score and test specificity rise:

```
opro analyze <repo> --paths examples/requirements.md
```

## Checkout flow

A signed-in user can purchase the items currently in their cart.

### Acceptance Criteria

- A valid card is charged and returns a transaction id
- An empty cart cannot be checked out
- A declined card shows a retryable error without losing the cart

## Login feature

Authenticated users reach their dashboard; bad credentials are refused.

### Acceptance Criteria

- Valid credentials return a session token and redirect to the dashboard
- An invalid password is rejected with a 401 and a generic error
- The session is cleared on logout
