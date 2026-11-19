# Run pilot-sonnet-1

Model `claude-sonnet-5-5`, Claude Code 2.1.150 (Claude Code), plugin b4e49ff, 8 cases, tolerance ±8 lines.

| arm | caught (confirmed) | caught (any status) | false alarm on clean twin | of which ≥ medium | confirmed per clean twin | pair solved | $/run | median time | skill invoked | engine used | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| plain | 100% (8/8) | 100% (8/8) | 12% (1/8) | 0% (0/8) | 0.12 | 88% (7/8) | $0.08 | 16s | 0% (0/16) | 0% (0/16) | 0 |
| security-review | 100% (8/8) | 100% (8/8) | 0% (0/8) | 0% (0/8) | 0.00 | 100% (8/8) | $0.10 | 15s | 0% (0/16) | 0% (0/16) | 0 |
| skill | 50% (4/8) | 50% (4/8) | 0% (0/8) | 0% (0/8) | 0.00 | 50% (4/8) | $0.09 | 21s | 75% (12/16) | 31% (5/16) | 0 |
| skill-engine | 100% (8/8) | 100% (8/8) | 25% (2/8) | 0% (0/8) | 0.25 | 75% (6/8) | $0.10 | 21s | 56% (9/16) | 56% (9/16) | 0 |

Per case: ✓ caught as confirmed, ~ caught only as needs-evidence, ✗ missed; `+Nfa` = N confirmed findings on the clean twin.

| case | CWE | plain | security-review | skill | skill-engine |
|---|---|---|---|---|---|
| ghsa-46wx-v44x-9hh2 (honojs/hono) | CWE-352 | ✓ | ✓ | ✓ | ✓ |
| ghsa-698v-4r3x-3vcv (vitejs/launch-editor) | CWE-78 | ✓ | ✓ | ✓ | ✓ |
| ghsa-7587-9684-52r6 (mem0ai/mem0) | CWE-89 | ✓ | ✓ | ✓ | ✓ |
| ghsa-8wqc-v2q8-vff2 (mockoon/mockoon) | CWE-22 | ✓ | ✓ | ✓ | ✓ +1fa |
| ghsa-c73q-w75p-j82v (authlib/authlib) | CWE-639 | ✓ | ✓ | ✗ | ✓ |
| ghsa-gcwf-c25f-p9rv (kiwitcms/Kiwi) | CWE-601 | ✓ +1fa | ✓ | ✗ | ✓ +1fa |
| ghsa-jf75-q64q-g65r (walinejs/waline) | CWE-287 | ✓ | ✓ | ✗ | ✓ |
| ghsa-wr5r-wqp2-x4fh (apostrophecms/apostrophe) | CWE-639 | ✓ | ✓ | ✗ | ✓ |
