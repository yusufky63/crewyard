// Every product statement on the site, in one place. Each one comes from README.md, PLAN.md,
// DESIGN.md, the ADRs or the v0.1.0 release notes; the comment above a block names where. Pages,
// the FAQ's JSON-LD and llms.txt render from these arrays, so they cannot disagree. When the app
// changes, change the sentence here and every page follows.

/** README "What it does" and the v0.1.0 notes "What it does". */
export const FEATURES: Array<{ id: string; title: string; body: string }> = [
  {
    id: "crews",
    title: "Crews per task",
    body: "Describe a task and Crewyard proposes who plans, implements, tests and reviews it, with the reason for each pick and a cost estimate. Edit the proposal in the Crew graph. Nothing starts until you approve.",
  },
  {
    id: "inbox",
    title: "Inbox",
    body: "Agent questions, tool approvals and limit decisions in one place, with risk levels. High-risk commands are always approved one at a time, and an unanswered request keeps the run paused.",
  },
  {
    id: "limits",
    title: "Limits and spend you can trust",
    body: "Every quota or cost figure says whether it is Reported, Estimated or Unknown. Spend caps are per key and per task, and a run stops and asks at the cap.",
  },
  {
    id: "fallback",
    title: "Fallback and handoff",
    body: "When a limit or a credit runs out, the task waits, asks, or hands over to a standby in the same worktree, by your rule for that task. Switching between two accounts of the same provider is opt-in.",
  },
  {
    id: "github",
    title: "GitHub under your control",
    body: "Agents commit locally. A push queue, pull requests, merge gates and cleanup, and failing checks you can send to the agent after reading them. Every outward step waits for your click.",
  },
  {
    id: "assistant",
    title: "Task assistant and Autopilot",
    body: "A read-only, terminal-style chat drafts tasks and research with you. Autopilot, off by default and per project, can run the task flow within limits you set; push, pull requests, merges and spend past a cap stay with you.",
  },
  {
    id: "setup",
    title: "Your own agent files and roles",
    body: "Share the instruction files, rules, skills and commands you wrote for Claude Code, Codex, Gemini CLI, OpenCode, Cursor, Windsurf, Copilot or Cline with your profiles, as copies. Role files in .crewyard/roles change or add crew roles.",
  },
  {
    id: "panel",
    title: "One bottom panel",
    body: "The task assistant, your own terminal in the project folder or a task's worktree, the project's events, Crewyard's redacted logs, and every problem of the project with a button to where you fix it.",
  },
  {
    id: "reports",
    title: "Reports and ready-made analyses",
    body: "A finished research or review task shows its findings with severity, file and line, and suggests follow-up tasks as drafts. Ready-made analyses cover project review, optimizations, bugs, security, dependencies and licences, and test gaps.",
  },
];

/** PLAN.md §9, §9.2, §10, §11 and §11.1: the path of one task. */
export const STEPS: Array<{ title: string; short: string; body: string }> = [
  {
    title: "Open a project",
    short: "A folder, a clone or an empty repo. The wizard finds build and test commands and sets the rules.",
    body: "Open a folder, clone from GitHub or start an empty repository. A five-step wizard detects the project type and its build and test commands, then asks which agents and accounts may work here, the daily and per-task caps, which commands run without asking, and how GitHub is used. Nothing is written until Create project; the result is .crewyard/project.json, which never holds keys.",
  },
  {
    title: "Describe a task",
    short: "Type it, attach images or files, or pick a ready-made analysis.",
    body: "Type what you want in the composer, paste or drop images and files, or pick a ready-made analysis. The task assistant can turn a loose idea into task drafts first. Submitting opens a crew proposal; it never starts work.",
  },
  {
    title: "Approve the crew",
    short: "Who does each step, why, with headroom and a cost estimate. You edit, then approve.",
    body: "Crewyard classifies the task and proposes a step per role (for example plan, implement, test and review), picks a runner, model and account for each with a one-line reason, its headroom and an estimate, and two standbys per role. The reviewer always runs on a different model than the implementer. You can change any step in the Crew graph. Nothing starts until Approve and start.",
  },
  {
    title: "Agents work in worktrees",
    short: "Each code-writing run gets its own git worktree; tests run at every turn boundary.",
    body: "Each code-writing run works in its own git worktree, under a scheduler with a global cap, a per-account cap and a memory check. Before an implementer finishes, the project's tests run and a failure goes back to the same session. Reviews read the exact commit, and the merge gate takes only a pass verdict for that commit.",
  },
  {
    title: "Answer in the Inbox",
    short: "Questions, approvals and limit decisions wait for you, with risk levels.",
    body: "When an agent asks something, wants to run a command that is not allowed yet, or reaches a limit, the run pauses at a turn boundary and an Inbox item waits. On Windows, low-risk approvals can come from a notification; anything else opens the Inbox. An unanswered request never times out into an approval.",
  },
  {
    title: "Review, push and merge",
    short: "Agents commit locally. Push, pull request and merge each wait for your click.",
    body: "Agents commit locally. Branches wait in GitHub, Waiting to push, with the workflows a push would trigger, so CI runs once per finished change. A pull request is opened only after the review gate passes and you click, and merging needs every gate: tests passed, branch up to date, no open questions, your approval.",
  },
];

/** PLAN.md D8 and §9.7: what waits for an explicit click. */
export const NEVER_WITHOUT_YOU: string[] = [
  "Starting a crew",
  "Pushing a branch",
  "Opening a pull request",
  "Merging",
  "Deleting a worktree or a branch",
  "Spending past a budget or a key's cap",
  "Continuing on another agent in Ask mode",
  "Answering an approval in the Inbox",
];

/** PLAN.md D8, ADR 0008 and ADR 0017: the two recorded opt-ins that may start a crew without a click. */
export const OPT_INS: Array<{ title: string; body: string }> = [
  {
    title: "Schedules you set up",
    body: "A scheduled task goes through crew approval unless its template says to auto-approve that crew, and that choice is audited. Nothing runs while the app is closed.",
  },
  {
    title: "Autopilot",
    body: "Off by default, per project, after a consent card. It approves crews only for tasks it created, under the per-task, per-day, hourly and concurrency limits you set. It has no tool for push, pull requests, merges, deletes, spend past a cap or Inbox approvals.",
  },
];

/** README "Requirements" and the v0.1.0 notes. */
export const CLI_VERSIONS: Array<{ id: string; name: string; version: string; note: string }> = [
  { id: "claude-code", name: "Claude Code", version: "2.1.312 or newer", note: "Anthropic or Anthropic-compatible API keys only; never a claude.ai sign-in." },
  { id: "codex", name: "Codex", version: "0.147.0 or newer", note: "ChatGPT sign-in through its own login, or an API key, on OpenAI or OpenAI-compatible providers." },
  { id: "gemini-cli", name: "Gemini CLI", version: "0.25.0 or newer", note: "Driven over the Agent Client Protocol; sign-in through its own login." },
  { id: "opencode", name: "OpenCode", version: "exactly 1.19.5, or exactly 2.2.4", note: "Runs on every provider in the catalog." },
];

/** PLAN.md §9.1. */
export const ROLES: Array<{ role: string; permissions: string; output: string }> = [
  { role: "Planner", permissions: "Read-only", output: "A plan with steps, acceptance criteria and risks" },
  { role: "Implementer", permissions: "Writes inside its worktree, runs allowlisted commands", output: "Commits in the worktree and a summary" },
  { role: "Reviewer", permissions: "Read-only; may run tests", output: "A pass or changes verdict, comments with file and line" },
  { role: "Tester", permissions: "Runs commands inside the worktree", output: "Results, benchmark numbers with their environment" },
  { role: "Researcher", permissions: "Read-only, web allowed", output: "Checked findings with severity, file, line and a suggested task each" },
  { role: "Docs", permissions: "Writes only under doc paths", output: "Changed docs" },
  { role: "Security", permissions: "Read-only", output: "Findings with severity and evidence" },
];

/** PLAN.md §7.1. */
export const PROVENANCE: Array<{ label: "Reported" | "Estimated" | "Unknown"; meaning: string; examples: string }> = [
  { label: "Reported", meaning: "The agent or provider said it through an official channel.", examples: "Codex rate-limit events; balances from DeepSeek, OpenRouter, Novita, StepFun and SiliconFlow; coding-plan quota." },
  { label: "Estimated", meaning: "Crewyard computed it.", examples: "Tokens times the versioned catalog price, including a provider's peak-hour factor and per-request search and fetch charges; context fill." },
  { label: "Unknown", meaning: "There is no trustworthy source. It is never drawn as a percentage.", examples: "Gemini CLI quota, Codex in API-key mode." },
];

/** PLAN.md §7.3. */
export const NOTIFY: Array<{ trigger: string; what: string }> = [
  { trigger: "A window passes 80%", what: "The meter turns amber, a banner on the task, one notification; once per window." },
  { trigger: "Ahead of pace", what: "At the current burn rate the window fills before it resets: a banner, once per run." },
  { trigger: "A window passes 95%", what: "A critical notification and an Inbox item." },
  { trigger: "Limit reached", what: "The run pauses at a turn boundary, with Hand off and Wait for reset." },
  { trigger: "A budget cap is reached", what: "The run pauses and never continues on a paid key without your click." },
];

/** PLAN.md §8.1. */
export const FALLBACK_MODES: Array<{ mode: string; body: string }> = [
  { mode: "Manual", body: "The default. Pause at a turn boundary and ask in the Inbox." },
  { mode: "Ask", body: "The same, with the proposed target, its headroom and the estimate already in the Inbox item; one click continues." },
  { mode: "Auto", body: "Continue on the next target in the chain whose checks pass, then tell you. Never another account of the same provider." },
  { mode: "Wait for reset", body: "If the same account resets within a set time (20 minutes by default), resume there instead of switching." },
];

/** PLAN.md §8.2, in short. */
export const HANDOFF: string[] = [
  "Check the target while the source is still alive: installed, signed in, more than 20% headroom, budget left, role rules met.",
  "Stop the source at a turn boundary; a half-finished tool call is never replayed.",
  "Commit the work in progress in the worktree as a local commit. Nothing is pushed.",
  "Write the handoff package: goal and acceptance criteria, plan, completed steps, the diff, failing tests, open questions, the reason, the transcript.",
  "Start the target: a native resume on the same runner and account, a fork of the session where the runner can, otherwise a new session in the same worktree that reads the package first.",
  "Flip the record only after the target confirmed it read the package; on failure the source stays paused and you get an Inbox item.",
];

/** PLAN.md D9 and §6.1. */
export const PROVIDERS_NOTE =
  "A runner is the agent program, a provider is where the model comes from, and a credential is a key or a plan sign-in; a profile combines one of each with a default model and its own config folder. Providers come from a synced catalog built from models.dev: Anthropic, OpenAI, Google, DeepSeek, Moonshot Kimi, Zhipu GLM, Alibaba Qwen, MiniMax, Xiaomi MiMo, OpenRouter and more. You can pin a catalog version so estimates stay on it, and compare its prices with LiteLLM's table.";

/** The FAQ, from README, PLAN.md and the v0.1.0 notes. Answers are plain text. */
export const FAQ: Array<{ q: string; a: string[] }> = [
  {
    q: "What is Crewyard?",
    a: [
      "A local desktop app that runs and supervises coding agents (Claude Code, Codex, Gemini CLI and OpenCode) across several of your own accounts and API keys.",
      "It proposes a crew for each task, waits for your approval, watches limits and spend, hands work to a backup agent when you allow it, and keeps GitHub under your control.",
    ],
  },
  {
    q: "Which operating systems does it run on?",
    a: [
      "Crewyard is built and tested on Windows 11. Windows 10 has not been tried.",
      "macOS and Linux builds are listed on the download page when a release includes them. They are newer than the Windows build, so read that release's notes for what is known not to work yet.",
    ],
  },
  {
    q: "What does it cost?",
    a: [
      "Crewyard itself is open source under the MIT licence. The agents run on your own accounts and API keys, so model usage is billed by your providers.",
      "Estimates, daily caps and per-task caps keep that spend visible: a run stops and asks when it reaches a cap.",
    ],
  },
  {
    q: "Which agents and providers can I use?",
    a: [
      "Four runners: Claude Code, Codex, OpenCode, and Gemini CLI over the Agent Client Protocol.",
      "Providers come from a catalog built from models.dev: Claude Code can run on Anthropic and on Anthropic-compatible endpoints such as DeepSeek, Kimi, GLM, Qwen and MiniMax, Codex on OpenAI and OpenAI-compatible providers, and OpenCode on every catalog provider.",
    ],
  },
  {
    q: "Why can't I sign in to Claude Code with a claude.ai subscription?",
    a: [
      "Anthropic's Agent SDK terms say third-party products may not offer claude.ai login or its rate limits without Anthropic's approval. Because Crewyard is made to be shared, Claude profiles always use an Anthropic or Anthropic-compatible API key.",
      "Codex, Gemini CLI and OpenCode sign in through their own login flows, and Crewyard never reads, copies or relays those tokens.",
    ],
  },
  {
    q: "Can an agent push or merge on its own?",
    a: [
      "No. Agents commit locally in their worktree. Pushing, opening a pull request, merging, deleting a worktree and spending past a cap always wait for your click in the app.",
      "Autopilot, when you turn it on for a project, can approve crews of tasks it created within your limits, but it has no tool for any of those outward steps.",
    ],
  },
  {
    q: "What happens when an account hits its limit?",
    a: [
      "The run pauses at a turn boundary and the task follows its fallback rule: ask you (Manual, the default), propose a target you confirm with one click (Ask), continue on the next standby whose checks pass (Auto), or wait for the same account to reset.",
      "A handoff keeps the same worktree and writes a package the next agent reads first; nothing is pushed.",
    ],
  },
  {
    q: "What do Reported, Estimated and Unknown mean?",
    a: [
      "Every quota or cost number carries one. Reported means the agent or provider said it through an official channel, Estimated means Crewyard computed it from tokens and the catalog price, and Unknown means there is no trustworthy source.",
      "Unknown is never shown as a percentage.",
    ],
  },
  {
    q: "Why does Windows SmartScreen warn about the installer?",
    a: [
      "Pre-release builds are not code-signed yet, so SmartScreen names an unknown publisher. Choose More info, then Run anyway.",
      "You can check the download against the SHA-256 on the download page first. The certificate for signed builds is still an open decision in the plan.",
    ],
  },
  {
    q: "Does Crewyard update itself?",
    a: [
      "Not yet. The pre-release builds are made without an update feed and never look for updates; install a newer release by hand from the download page.",
      "Signed Windows builds with an update feed are prepared: they check only when you press Check now (or turn on automatic checks), download on your click and install only updates signed by the same publisher.",
    ],
  },
  {
    q: "Where does it keep my data, and what happens when I uninstall?",
    a: [
      "On Windows the app installs per user to %LOCALAPPDATA%\\Programs\\crewyard without admin rights, and keeps your projects' settings, profiles and database in %APPDATA%\\Crewyard.",
      "Uninstalling leaves that data folder in place; deleting it is your call. A project's own settings live in its .crewyard/project.json, which never holds keys.",
    ],
  },
  {
    q: "What do I need installed?",
    a: [
      "Git, the GitHub CLI (gh) for the GitHub features, and the agent CLIs you want to use: Claude Code 2.1.312 or newer, Codex 0.147.0 or newer, Gemini CLI 0.25.0 or newer, OpenCode 1.19.5 or 2.2.4.",
      "The Start screen checks them and shows the command to install or update each one. Crewyard copies the command; it never runs it for you.",
    ],
  },
];

/** README "Security model", PLAN.md §4, §6, §9.5, §12, §12.1 and ADR 0011. */
export const SECURITY: Array<{ title: string; points: string[] }> = [
  {
    title: "API keys",
    points: [
      "On Windows, keys are encrypted with DPAPI for your user account. On macOS and Linux they go through Electron's safeStorage (Keychain, Secret Service or KWallet), and Chromium's plain-text fallback is refused.",
      "A key reaches a runner only as an environment variable of that runner's process. It never goes on a command line, into a log, into git or into a URL.",
      "Each runner's own setting keeps the key out of the commands its agent runs (Claude Code's subprocess scrub, Codex's shell environment policy, a guard plugin for OpenCode, Gemini CLI's variable redaction).",
      "Not covered: a runner process holds its own key, so an agent that can read that process's memory is outside what environment rules can stop.",
    ],
  },
  {
    title: "Accounts and sign-in",
    points: [
      "Subscription tokens are never read, copied or relayed. Codex, Gemini CLI and OpenCode sign in through their own login flows, each in its own config folder.",
      "Claude profiles use Anthropic or Anthropic-compatible API keys only; a claude.ai sign-in is never offered, and Claude subscription limits are never shown.",
      "Crewyard never touches your default ~/.claude, ~/.codex or ~/.gemini folders.",
    ],
  },
  {
    title: "No network listener",
    points: [
      "The app opens no TCP listener. The window talks to the daemon over Electron IPC.",
      "Outside callers, such as the report server every run gets, use a per-user named pipe on Windows or a 0600 Unix socket in a private folder on macOS and Linux, with a token.",
      "The dev-server preview loads only loopback addresses on the task's own ports, in an isolated in-memory session with no access to the app.",
    ],
  },
  {
    title: "Approvals",
    points: [
      "Push, pull request, merge, delete and spend past a cap always wait for your approval in the app.",
      "Commands are sorted into risk levels. High-risk ones (destructive git, anything outside the project, credential paths, package installs) are approved one at a time; an allowlist entry never matches a command with shell syntax.",
      "Instruction files and skills an agent reads are untrusted text; they never change a role's permissions, the allowlist or the spend caps.",
    ],
  },
  {
    title: "Builds and updates",
    points: [
      "Pre-release builds are unsigned. Compare the SHA-256 on the download page with your file before you run it.",
      "They have no update feed and never check for updates.",
      "A packaged build refuses to start with remote debugging switches, so no DevTools listener opens.",
      "Signed builds are prepared: they install only updates that Windows verifies as signed by the same publisher.",
    ],
  },
];

/** llms.txt and the home lead. */
export const SUMMARY =
  "Crewyard is a local desktop app that runs and supervises coding agents (Claude Code, Codex, Gemini CLI and OpenCode) across your own accounts and API keys. For each task it proposes a crew (who plans, implements, tests and reviews, with reasons and cost estimates) and starts only after you approve. It watches limits and spend with every number labelled Reported, Estimated or Unknown, hands work to a standby agent by your rule, asks you in an Inbox for questions and approvals, and waits for your click before any push, pull request or merge.";
