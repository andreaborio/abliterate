# Run pilot-sonnet-2

Model `claude-sonnet-5-5`, Claude Code 2.1.150 (Claude Code), plugin b4e49ff, 12 cases, tolerance ±8 lines.

| arm | caught (confirmed) | caught (any status) | false alarm on clean twin | of which ≥ medium | confirmed per clean twin | pair solved | $/run | median time | skill invoked | engine used | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| plain | 92% (11/12) | 100% (12/12) | 8% (1/12) | 0% (0/12) | 0.08 | 83% (10/12) | $0.09 | 20s | 0% (0/24) | 0% (0/24) | 0 |
| security-review | 92% (11/12) | 100% (12/12) | 8% (1/12) | 8% (1/12) | 0.08 | 83% (10/12) | $0.12 | 18s | 0% (0/24) | 0% (0/24) | 0 |
| skill | 25% (3/12) | 25% (3/12) | 8% (1/12) | 8% (1/12) | 0.08 | 17% (2/12) | $0.08 | 13s | 88% (21/24) | 46% (11/24) | 0 |
| skill-engine | 92% (11/12) | 92% (11/12) | 8% (1/12) | 8% (1/12) | 0.08 | 83% (10/12) | $0.11 | 23s | 67% (16/24) | 58% (14/24) | 0 |

Per case: ✓ caught as confirmed, ~ caught only as needs-evidence, ✗ missed; `+Nfa` = N confirmed findings on the clean twin.

| case | CWE | plain | security-review | skill | skill-engine |
|---|---|---|---|---|---|
| ghsa-2658-85cv-9wwq (mljar/mercury) | CWE-79 | ✓ | ✓ | ✓ | ✓ |
| ghsa-2jp7-wwpg-3p9w (ether/etherpad) | CWE-79 | ✓ +1fa | ✓ +1fa | ✓ +1fa | ✓ +1fa |
| ghsa-46wx-v44x-9hh2 (honojs/hono) | CWE-352 | ✓ | ✓ | ✗ | ✓ |
| ghsa-698v-4r3x-3vcv (vitejs/launch-editor) | CWE-78 | ✓ | ✓ | ✓ | ✓ |
| ghsa-7587-9684-52r6 (mem0ai/mem0) | CWE-89 | ✓ | ✓ | ✗ | ✓ |
| ghsa-8wqc-v2q8-vff2 (mockoon/mockoon) | CWE-22 | ✓ | ✓ | ✗ | ✓ |
| ghsa-c73q-w75p-j82v (authlib/authlib) | CWE-639 | ✓ | ✓ | ✗ | ✓ |
| ghsa-gcwf-c25f-p9rv (kiwitcms/Kiwi) | CWE-601 | ✓ | ✓ | ✗ | ✓ |
| ghsa-jf75-q64q-g65r (walinejs/waline) | CWE-287 | ✓ | ~ | ✗ | ✓ |
| ghsa-jxwj-j7wr-gfrw (apostrophecms/apostrophe) | CWE-79 | ~ | ✓ | ✗ | ✓ |
| ghsa-v667-gc2r-2xm7 (whyour/qinglong) | CWE-287 | ✓ | ✓ | ✗ | ✓ |
| ghsa-wr5r-wqp2-x4fh (apostrophecms/apostrophe) | CWE-639 | ✓ | ✓ | ✗ | ✗ |
