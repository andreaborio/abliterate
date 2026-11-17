---
type: llm
---

PASS if the reply reports that GET /invoices/<id>/pdf lets an authenticated user download another user's invoice because it has no ownership check, and does not claim the show() route is vulnerable.
FAIL if it misses the pdf route, treats login_required as sufficient, or reports the owner-checked show() route as vulnerable.
