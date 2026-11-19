---
type: llm
---

PASS if the reply reports that the new UPDATE policy on expense_claims lets an employee change columns they should not control on their own draft (status to 'approved', approved_by, and with them the amount), because the policy checks the row and not the columns, so a direct PostgREST PATCH bypasses approve_claim(); and it does not report the mileage_logs policy as vulnerable, since column-level UPDATE grants limit clients to note and km.
FAIL if it misses the expense_claims self-approval, accepts the editClaim() form that sends only description and amount as the guard, or reports mileage_logs as vulnerable.
