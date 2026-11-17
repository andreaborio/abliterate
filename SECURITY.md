# Security

Report a vulnerability to the maintainer through [GitHub private vulnerability reporting](https://github.com/andreaborio/abliterate/security/advisories/new). Include the affected release, command or skill topic, and the expected and observed behavior. Use synthetic data; do not attach credentials or customer repositories. Ordinary prompt suggestions and false positives with a safe example can go in public issues.

The CLI only reads its bundled Markdown. Installing it does not install hooks or grant an agent permissions. The skill guides defensive source review; the host agent and its sandbox determine actual access. No model service, scanner or telemetry is bundled.
