# ADR 0002: API keys encrypted with DPAPI from the daemon

Date: 2026-10-30. Status: accepted.

## Problem

PLAN.md §6 stores API keys encrypted with Windows DPAPI (user scope), one file per key, and keeps them out of command lines, logs, commits and URLs. Keys are read by the daemon, which runs as an Electron utility process. The obvious tool, Electron's `safeStorage`, is documented as main-process only.

## Options

1. **The daemon calls DPAPI itself through .NET `ProtectedData` in Windows PowerShell 5.1** (`powershell.exe -NoProfile -NonInteractive -EncodedCommand <script>`), secret on stdin, result on stdout, both base64.
2. Electron `safeStorage` in the main process, with the daemon asking the main process to encrypt and decrypt over the existing message port.
3. A native DPAPI binding (for example a `node-gyp` module calling `CryptProtectData`).

## Decision

Option 1.

- Checked on this machine on 2026-10-30 with Electron 45.1.0: in a utility process `require("electron")` exposes only `LanguageModelUtility`, `localAIHandler`, `net` and `systemPreferences`; `safeStorage` is absent. In the main process it works.
- Option 2 would make the main process interpret messages (it only relays them today, ADR 0001) and would tie the key files to Chromium's `Local State` key: `safeStorage` on Windows encrypts with an app key that is itself DPAPI-protected inside the profile, so a new or throwaway `userData` folder (the screenshot mode uses one) could not read keys stored by another.
- Option 3 brings back a native module to rebuild per Electron ABI, which ADR 0001 avoided.
- Windows PowerShell 5.1 ships with every supported Windows 10 and 11 install. One call takes about 0.3 s, which is fine for adding a key, a balance check or starting a run.
- Entropy `crewyard/secret/v1` is passed to `Protect`/`Unprotect`, so other programs running as the same user cannot decrypt a blob with a plain `CryptUnprotectData` call unless they also know the value. DPAPI does not protect against code that runs as the same user and reads our source; neither does `safeStorage` (Electron docs).
- Files: `<dataDir>/secrets/<credentialId>.bin`, written through a temp file and a rename with retry. The file name is the credential id, not the alias, so renaming never touches the secret. The database stores only alias, provider, kind and caps.
- The IPC returns aliases and an `isSet` flag only. Decrypted keys leave the daemon only as child-process environment variables (adapters) or an `Authorization` header (balance checks). Errors never include the key; a test checks this.
- On a non-Windows platform the daemon refuses to store keys instead of writing them unencrypted.

## Sources

- Electron `safeStorage` docs, https://www.electronjs.org/docs/latest/api/safe-storage, opened 2026-10-30: main process only; uses DPAPI on Windows.
- .NET `ProtectedData.Protect`, https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata.protect, opened 2026-10-30: `System.Security.dll` in .NET Framework, `CurrentUser` scope, optional entropy.
- cc-switch, https://github.com/farion1231/cc-switch, MIT, about 150k stars, not archived, opened 2026-10-30: read `src-tauri/src/services/balance.rs` only to learn the balance endpoint URLs, response field names and units. `packages/daemon/src/providers/balances.ts` is our own code; nothing was copied or translated.
- DeepSeek balance endpoint checked live with the user's key and approval on 2026-10-30 (`providers.live.test.ts`, opt-in): response `{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }`, amounts as strings.
- DeepSeek "Get user balance", https://api-docs.deepseek.com/api/get-user-balance, opened 2026-10-30.

## Windows notes

- `powershell.exe` is resolved from `%SystemRoot%\System32\WindowsPowerShell\v1.0`, never from PATH, so a planted `powershell.exe` in the working folder or earlier on PATH is not used.
- Spawned through `@crewyard/proc` `start()` (cross-spawn, `windowsHide: true`, no shell). `$ProgressPreference = 'SilentlyContinue'` keeps the first-run "Preparing modules" CLIXML record off stderr.
- Constrained Language Mode (AppLocker or WDAC policies) blocks `Add-Type` and would make every encrypt and decrypt fail with a clear error. Not tested here.

## Security notes

- The secret is never on a command line: the script is in `-EncodedCommand` and holds no secret; the key is only on stdin.
- DPAPI user scope means another Windows account, or a copy of the files on another machine, cannot decrypt them. Resetting the Windows password through an administrator (not a normal change) loses the DPAPI master key, and the keys must be pasted again.

## Rollback

`SecretStore` takes a `Protector` (`packages/daemon/src/providers/dpapi.ts`). Moving to option 2 or 3 means writing another `Protector` and re-encrypting the files once: decrypt with the old protector, encrypt with the new one, keep the same file names.
