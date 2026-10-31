# Security policy

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (https://github.com/yusufky63/crewyard/security/advisories/new). Please do not open a public issue, discussion or pull request for a security problem.

Include what you can of:

- the Crewyard version (Settings → About) and Windows build;
- what an attacker can do, and what they need first (another local user, a malicious repository, a crafted model reply, a compromised provider);
- steps to reproduce, or a proof of concept;
- whether the problem is already public anywhere.

Never paste a real API key, token or private file in the report. If a key leaked while you tested, revoke it at the provider first.

Crewyard is maintained by one person. Reports are answered on a best-effort basis; you will hear back in the advisory thread, and the fix and the credit you want are agreed there before anything is published.

## Supported versions

Only the latest release gets security fixes. Crewyard is pre-release software: there are no long-term support branches.

## Scope

In scope, for example:

- an API key leaving DPAPI-encrypted storage other than as an environment variable of a runner process: on a command line, in a log, in git, in a URL, or to an agent shell;
- an outward action (push, pull request, merge, delete, spend past a cap) happening without the user's approval in the app, including through Autopilot or the task assistant;
- the external named pipe accepting a caller without its token, or any TCP listener opened by the app;
- the dev-server preview reaching a non-loopback address, another task's port or the app's own session;
- a crafted repository, role file, agent file, model reply or provider response that runs code, reads files outside the project or escalates a runner's permissions;
- an update installed without a valid signature from the publisher.

Out of scope:

- vulnerabilities in the runner CLIs themselves (Claude Code, Codex, Gemini CLI, OpenCode) or in a provider's service; report those to their owners;
- the SmartScreen warning on an unsigned pre-release build;
- attacks that already need code running as the same Windows user, or administrator rights, unless Crewyard makes them meaningfully easier;
- denial of service by a local user against their own Crewyard.

The security model is described in the README ("Security model") and in PLAN.md.
