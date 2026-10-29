// Live check against the installed codex. Spends nothing: it only calls initialize, account/read
// and account/rateLimits/read, never a model turn.
//
//   $env:CREWYARD_LIVE="1"; node packages/adapter-codex/scripts/live.mjs [CODEX_HOME]
//
// CODEX_HOME defaults to the CODEX_HOME variable, then ~/.codex. Emails, account and user ids are
// redacted before printing.

import { homedir } from "node:os";
import { join } from "node:path";
import { AppServer } from "../src/appserver.ts";

if (process.env.CREWYARD_LIVE !== "1") {
  console.log("Skipped: set CREWYARD_LIVE=1 to run against the installed codex.");
  process.exit(0);
}

const codexHome = process.argv[2] ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
const REDACT = /email|account_?id|user_?id|workspace_?(id|name)/i;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, REDACT.test(k) && v !== null ? "<redacted>" : redact(v)]));
  }
  return value;
}

const server = await AppServer.launch({}, { codexHome });
try {
  const init = await server.initialize({ experimentalApi: false });
  console.log("initialize:", JSON.stringify(redact({ ...init, codexHome: "<CODEX_HOME>" }), null, 2));
  const account = await server.rpc.request("account/read", { refreshToken: false }, { timeoutMs: 30_000 });
  console.log("account/read:", JSON.stringify(redact(account), null, 2));
  try {
    const limits = await server.rpc.request("account/rateLimits/read", undefined, { timeoutMs: 30_000 });
    console.log("account/rateLimits/read:", JSON.stringify(redact(limits), null, 2));
  } catch (err) {
    console.log("account/rateLimits/read failed:", err.message);
  }
} finally {
  await server.close();
}
