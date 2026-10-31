## Install

These builds are not signed with a paid certificate yet, so each system warns once before the first start, and they do not update themselves: get the next version from this page. To check a download, compare the output of `Get-FileHash <file>` (PowerShell), `shasum -a 256 <file>` (macOS) or `sha256sum <file>` (Linux) with its line in `SHA256SUMS.txt`.

**Windows 11, x64:** run `Crewyard-Setup-<version>-x64.exe`. It installs for your user only, without an admin prompt. SmartScreen says "Windows protected your PC" because the publisher is unknown: choose More info, then Run anyway.

**macOS 13 (Ventura) or later:** `-arm64` is for Apple silicon (M1 and later), `-x64` for Intel Macs. Open the `.dmg` and drag Crewyard to Applications, or unzip the `-mac.zip`. The app is not notarized, so the first start is blocked with a message that Apple could not verify it. Open System Settings, then Privacy & Security, scroll down, choose Open Anyway next to Crewyard and confirm. Or, in Terminal: `xattr -dr com.apple.quarantine /Applications/Crewyard.app`.

**Linux, x64 (glibc 2.35 or newer: Ubuntu 22.04, Debian 12, Fedora 36 and later):**

- Debian and Ubuntu: `sudo apt install ./crewyard_<version>_amd64.deb`. It adds Crewyard to the app menu and `crewyard` to your PATH, and on Ubuntu 24.04 and later installs the AppArmor profile Chromium's sandbox needs. Prefer it there.
- Any distribution: `chmod +x Crewyard-<version>-x86_64.AppImage`, then run it. It needs FUSE 2 (`sudo apt install libfuse2`, or `libfuse2t64` on Ubuntu 24.04). Where user namespaces are restricted (Ubuntu 24.04 and later) its launcher starts the app without Chromium's sandbox.

API keys are kept by Windows DPAPI, the macOS Keychain, or the Linux Secret Service or KWallet. Without one of these, Crewyard refuses to store a key rather than keep it in the clear.
