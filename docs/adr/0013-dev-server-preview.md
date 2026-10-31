# ADR 0013: Dev-server preview in the inspector

**Status:** accepted, 2026-10-31. Feature scan "Later" item (dev-server preview), taken up now.

## Problem

An agent working on a web app starts its dev server and prints where it listens (`Local: http://localhost:5173/`). To look at the result you copy that address into a browser, find the element that is wrong, and describe it back in words. omux's Browser tab shows the idea working: it opens the server a session printed and has a pick button that hands the clicked element to the agent.

Crewyard must do this without breaking three rules it already has:

- **No listener of ours** (PLAN.md §2, §4): the app opens no TCP port. Showing a page someone else serves is fine; proxying it is not.
- **The page is untrusted.** It is code an agent just wrote, plus whatever it pulls in. It must not reach Crewyard's IPC, the daemon, keys, cookies of the main window or the file system, and what the picker takes from it is data, never instructions (AGENTS.md).
- **Nothing starts without the user** (DESIGN.md §2.6): no page loads on its own, and closing the panel never stops anything.

The feature scan flagged the constraints on 2026-10-30: an isolated partition and no listener of ours.

## Options

### Where the page lives

1. **`<webview>` tag in the renderer.** It sits in the DOM, so it scrolls, clips and stacks under our own menus and dialogs for free. But Electron's own docs say "We currently recommend to not use the `webview` tag" and point to `WebContentsView` or an `iframe`. It is off by default since Electron 5; turning it on (`webviewTag: true`) on the main window means every script in our renderer could create one, so the `will-attach-webview` checks of the security checklist (item 12) become the only thing between a renderer bug and a guest with a preload. The guest's options also come from attributes the renderer writes.
2. **`WebContentsView` owned by the main process.** Main creates it, gives it its own `webPreferences` and session, adds it to the window with `contentView.addChildView` and places it with `setBounds`. The renderer only reports where the frame is and asks main to load an address; main decides whether that address is allowed. The cost: a native view is drawn above the window's own page, so our menus and dialogs would sit under it, and it does not scroll with the inspector.

**Chosen: 2.** The security boundary stays in one process that the page cannot script, and the main window keeps `webviewTag` off. The stacking cost is handled in the renderer: the view is hidden while a dialog or menu is open, while the Preview tab is not shown, and while the inspector is collapsed; its bounds are cut to the visible part of the inspector.

### Which addresses may load

1. **Any address the user types** (omux). Simple, but then the preview is a general browser inside Crewyard, with none of a browser's safety UI.
2. **Loopback only, on a port this task is known to use:** the worktree's bootstrap port (`CREWYARD_PORT`, feature scan A1, in `packages/daemon/src/worktrees/bootstrap.ts`) and ports in loopback URLs the task's runs printed in their tool output.

**Chosen: 2.** A dev server of this task is exactly what the feature is for; everything else goes to the user's own browser.

## The choice

- **Inspector tab `Preview`.** It lists the candidate addresses (the bootstrap port first, then printed URLs newest first, deduplicated). Nothing loads until you click `Load`. A toolbar has reload, `Pick element`, `Open in browser` and `Unload`.
- **Addresses** (`packages/core/src/preview.ts`, `previewVerdict`):
  - scheme `http:` or `https:` only;
  - host exactly `localhost`, `127.0.0.1` or `[::1]` after WHATWG URL parsing (so `127.1` counts as `127.0.0.1`, and `localhost.`, `127.0.0.2`, `[::ffff:127.0.0.1]`, `0.0.0.0` and any other name are refused);
  - no user name or password in the URL;
  - the port (80 or 443 when none is written) must be one of the task's ports.
  - Printed `0.0.0.0` and `[::]` (servers bound to every interface) are read as `localhost` and `[::1]`; ANSI colour codes are removed first, since Vite prints the port in bold.
- **The daemon** answers `preview.targets { taskId }` with the stored bootstrap port and the URLs in the task's stored `run.tool.update` events (the newest 400 that mention a loopback host), so the list survives a restart and needs no new table. Main asks the daemon itself before every load; it never trusts a port list from the renderer.
- **The picker** runs in an isolated world (`executeJavaScriptInIsolatedWorld`), so the page cannot see or replace its functions, and ignores synthetic events (`isTrusted`). It returns the element's outer HTML, a selector, its size and a fixed list of computed style properties. Main checks the shape and caps it (`capPick`): HTML 16 KB, cut on a character boundary and marked; 24 style properties from the allow-list, values 200 characters; selector 300 characters. The renderer shows the result as plain text with an optional note and, on `Add to queue`, sends it through `runs.message`, so it becomes a queued message of the step (ADR 0005) that you can still edit or delete. The message says it is page content quoted as data, and the HTML sits in a code fence longer than any backtick run inside it, so it cannot close the fence.
- **The element's screenshot** (added once image attachments landed, PLAN.md §5.3). The picker also reports the element's viewport box; after it removes its outline it waits two frames (or 150 ms where frames are throttled) before answering, so the outline is not in the image. Main then:
  - checks the box (finite numbers, positive size; `pickBox` in `apps/desktop/src/main/preview/shot.ts`), multiplies it by the page zoom, grows it to whole pixels and clamps it to the view's own size (`shotRect`), which is the part of the frame visible in the inspector. Nothing in sight gives no screenshot, and the pick stays text only;
  - captures that rectangle with `webContents.capturePage(rect)` of the preview view only. The image comes at the display's scale (a 132 x 34 px button is 264 x 68 px at 200 %);
  - scales its longest edge down to 1,568 px and, while the PNG is over the 5 MB image cap, shrinks it by 0.7 up to three times, then gives up rather than send a larger image (`captureShot`);
  - stores it through `attachments.add` as `pick-<yyyymmdd-hhmmss>.png`, only while the same view still shows the task the pick started on and the pick was not cancelled meanwhile.

  The draft shows the thumbnail, its alt text naming the element's selector, with a remove button. `Add to queue` sends `runs.message { text, attachments: [id] }`; the text adds, after the fence, one line of ours naming the file as "a screenshot of the element quoted above", so no page text is ever outside the quote. Each runner gets the image through its own input; one without image input gets its path in the text (`withAttachments`), and the draft says so. Removing it, discarding the pick, a new pick or leaving the tab gives the upload back (`attachments.discard`) at once. Once queued it is part of the queued message, which you can still delete until the turn boundary.

## Sources

| Source | Opened | Stars | License | Archived |
|---|---|---|---|---|
| https://www.electronjs.org/docs/latest/api/web-contents-view | 2026-10-31 | 123,659 (electron/electron) | MIT | no |
| https://www.electronjs.org/docs/latest/api/webview-tag (the "not recommended" warning, `webviewTag` off since 5) | 2026-10-31 | same | MIT | no |
| https://www.electronjs.org/docs/latest/tutorial/security (items 3, 4, 5, 12, 13, 14) | 2026-10-31 | same | MIT | no |
| https://www.electronjs.org/docs/latest/api/session (`fromPartition` without `persist:` is in memory; permission, device and display-media handlers; `will-download` can be prevented) | 2026-10-31 | same | MIT | no |
| https://www.electronjs.org/docs/latest/api/web-contents (`will-navigate` is not emitted for `loadURL`; `will-redirect` cancels the whole navigation; `will-frame-navigate`; `executeJavaScriptInIsolatedWorld`) | 2026-10-31 | same | MIT | no |
| https://www.electronjs.org/docs/latest/api/web-contents (`capturePage([rect, opts])`: "the area of the page to be captured"; `getZoomFactor`) | 2026-10-31 | same | MIT | no |
| https://www.electronjs.org/docs/latest/api/native-image (`resize` keeps the ratio, quality `best`; `getSize`, `toPNG`, `isEmpty`) | 2026-10-31 | same | MIT | no |
| https://github.com/onurozcan/omux `Sources/omux/Browser.swift`, `Sources/omux/Store.swift` (`mentionedURLs`) | 2026-10-31 | 75 | MIT | no |

What omux does differently, and why we do not: it uses the default website data store (shared cookies), loads the last printed server as soon as the panel shows, accepts any typed address, and writes picks to files the agent is told to read. Ideas only; no code was copied or ported.

## Windows notes

- `capturePage` of the main window does not include child views, so `CREWYARD_SHOT` screenshots show the tab, the list and the frame, never a loaded page.
- The element screenshot's rectangle is in DIPs of the view; `capturePage` returns device pixels. Checked with Electron 45.1.0 at `--force-device-scale-factor` 1, 1.5 and 2: a 100 x 50 rectangle gave 100 x 50, 150 x 75 and 200 x 100 px, and `getSize()` and `toPNG()` agree, so the edge cap applies to real pixels.
- Bounds are CSS pixels from the renderer; the window has no zoom of its own, so they equal DIPs at every Windows scaling.
- `localhost` resolves through the hosts file and may try `::1` before `127.0.0.1`; a server bound only to IPv4 still loads, and the list shows the address as printed.
- Windows Defender Firewall never prompts: the app only connects out to loopback, it listens on nothing.

## Security notes

- **Session:** `session.fromPartition("crewyard-preview")`, no `persist:` prefix, so cookies, storage and cache live in memory and go when the app quits; `Unload` also clears them. It shares nothing with the main window's default session.
- **webPreferences:** no preload, `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`, `webviewTag: false`, `devTools: false`, `safeDialogs: true`, `navigateOnDragDrop: false`, `spellcheck: false`. The page has no `window.crewyard` and no channel to `ipcMain`; the main process's `ipcMain` handlers also check that the sender is the main window.
- **Navigation:** `will-navigate`, `will-redirect` and `will-frame-navigate` (main frame) apply the same verdict, so a link, a script redirect or a 302 off loopback or to another port is cancelled and shown as `Blocked <url>`. Subframes and subresources may load other http(s) origins, as in any browser; subframes may only navigate to `http`, `https`, `about`, `data` and `blob` (no `file:` or `chrome:`).
- **Certificates:** a certificate error is accepted only for an address the verdict allows (a dev server's self-signed certificate on the task's loopback port; nobody can sit between the app and loopback); every other one keeps Chromium's refusal. A client-certificate request is answered with none, where Electron's default would hand over the first certificate in the Windows store.
- **Blocked outright:** new windows (`setWindowOpenHandler` denies; the tab shows the address, and `Open in browser` opens it only on your click when it is an allowed one), downloads (`will-download` prevented), every permission request and check (camera, microphone, notifications, geolocation, clipboard, HID, serial, USB, display capture) and `beforeunload` prompts. HTTP authentication keeps Electron's default, which cancels it.
- **Electron fuses unchanged**, no new command-line switch, no remote debugging.
- **Loads only on a click** in the tab; switching the inspector to another task or closing it unloads the page. Unloading never touches the dev server or the run: Crewyard did not start the server and does not stop it.
- **Picked content** is untrusted: never rendered as HTML in Crewyard (shown in a `<pre>` as text), capped, quoted in the message, and only sent when you press `Add to queue`.
- **Screenshot privacy:** only `capturePage` of the preview's own WebContents is called, never of the main window or the screen, so the image cannot hold Crewyard's UI, another app or another task's page (there is one preview page, and the capture is dropped if it moved to another task). Only the picked element's rectangle within the visible view is captured; whatever the page draws there (including data it shows) goes with the message, which is why the draft shows the image and lets you remove it before queuing. It is stored like any other upload under the app's data folder, checked by its PNG signature and size in the daemon, and the page never learns that a screenshot was taken. The picker's box is page data: a page that lies about it can only move the rectangle inside its own view.

## Rollback

The change adds one IPC area (`preview`), main-process IPC channels prefixed `crewyard:preview-`, a renderer tab and strings. It adds no table, setting or migration. Reverting the code removes the tab; the in-memory partition leaves nothing on disk. Element screenshots are ordinary attachments: ones already queued stay with their messages, unused ones go in the daemon's daily sweep.
