---
name: browser-control
description: Get browser content and control the user's real, signed-in Edge browser via a persistent CDP session. Use to read/scrape/extract page content, or to navigate, click, type/fill forms, screenshot, and manage tabs (open/switch/close) in the already-logged-in browser. Requires Edge running with "Allow remote debugging" enabled.
---

# Browser Control (persistent CDP)

Drive the user's real, signed-in Edge. Safe by construction: this never relaunches Edge, never passes `--user-data-dir`, and never force-kills the browser. It attaches to an Edge that is already running.

## Hard safety rules

- **Never** launch or relaunch the real profile with `--user-data-dir` or a directory junction. That makes Edge treat the profile as non-default, breaks **App-Bound cookie encryption**, and Chromium then **deletes** the affected cookies. This session only *attaches* to an already-running Edge.
- **Never** `taskkill /F` Edge.
- **One expected prompt:** when the session first connects to Edge, Edge shows a permission prompt. Attaching to tabs and every operation after that are **silent**. Do NOT relaunch the session repeatedly to "retry" — reuse the live one.
- **App-Bound `v20` encryption:** Edge's saved cookies *and* passwords can only be used by the running browser process. No external process can decrypt them. You therefore **cannot extract a saved login** — for logins use the browser's own autofill (see "Login with a saved account").

## Prerequisites

- Edge is running.
- **"Allow remote debugging" is enabled:** open `edge://inspect`, scroll to the bottom, and turn on **Allow remote debugging** (this is what exposes `DevToolsActivePort`). If it is off the session cannot connect — ask the user to enable it; the wait loop below then connects automatically.
- Node.js available.

## Session lifecycle

The session is a background Node process (`cdp.mjs`) exposing an HTTP control API on `127.0.0.1:9333`. **Launch it once and reuse it for the whole task** — do not relaunch per command. It is `stdlib + global WebSocket` only (no `npm install`).

### Launch (PowerShell)
Use `launch.ps1` — it starts `cdp.mjs` with **`CREATE_BREAKAWAY_FROM_JOB`**, which is REQUIRED: opencode's shell tool waits on a Job Object (process tree), so a daemon started with plain `Start-Process` keeps the job alive and the tool call hangs until timeout. Breakaway makes the launch return instantly. It also self-heals `cdp.pid` and no-ops if a session already owns the port (the port is the source of truth — never trust `cdp.pid` alone).
```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8
& "$env:USERPROFILE\.config\opencode\skills\browser-control\launch.ps1"
```
After launching, run `Wait-Ready` (below) **as the active command in the same turn** — it is the poller that detects the user's Edge permission grant and returns control.

### Wait-for-ready (auto-proceeds on the user's one-time permission grant)
```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8   # pages with CJK/emoji text come back mangled without this
function Post($obj){ Invoke-RestMethod -Uri "http://127.0.0.1:9333/cmd" -Method Post -Body ($obj|ConvertTo-Json -Depth 10 -Compress) -ContentType "application/json" -TimeoutSec 90 }
function GetS($p){ Invoke-RestMethod -Uri "http://127.0.0.1:9333$p" -Method Get -TimeoutSec 5 }
function Wait-Ready($t=120){ $s0=Get-Date; while($true){ try{ $s=GetS '/status'; if($s.connected){return $s} }catch{} $el=((Get-Date)-$s0).TotalSeconds; if($el -ge $t){ throw "still waiting - grant the Edge permission prompt, then re-run" }; Write-Host ("  waiting for connect... {0}s" -f [int]$el); Start-Sleep 2 } }
Wait-Ready 120 | ConvertTo-Json -Compress
```
The connect is gated on the user's single permission grant; this polls with a heartbeat and returns the moment the session is up. **Do a quick one-shot `/status` only AFTER the user has confirmed they granted it** — checking too early is why it looks "stuck."

### Stop
Kill the process that actually owns port 9333 — the pid file may be stale, but the port never lies.
```powershell
$spid = netstat -ano | Select-String ':9333\s+.*LISTENING' | ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -First 1
if ($spid) { Stop-Process -Id $spid -Force; "stopped $spid" } else { "not running" }
```

## The API (call via `Post @{cmd=...}`)

| cmd | args | result |
|-----|------|--------|
| `status` | — | connected, active target, attachCount |
| `targets` | — | array of page/other tabs: `{type,id,url,attached}` |
| `create` | `url` (default `about:blank`) | `{targetId: "..."}` (no prompt) |
| `attach` | `targetId` (default: first page) | attach a session (silent); increments attachCount |
| `navigate` | `url` | navigate the active tab |
| `snapshot` | — | interactive elements, each tagged `ref` (`e1`,`e2`,…) with `tag`,`type`,`id`,`text` |
| `click` | `ref` (or `css`) | real mouse click at the element |
| `type` | `ref`,`text`,`submit?` | focus + insert text (+ Enter if `submit`) |
| `press_key` | `key` (`Enter`,`Tab`,`Escape`,`Backspace`,`ArrowUp/Down/Left/Right`) | key event |
| `eval` | `expr` | run JS in the page; returns `{result: value}` |
| `text` | `max` (default 8000) | page `innerText` (truncated); returned as `{text: "..."}` |
| `title` | — | `document.title`; returned as `{title: "..."}` |
| `screenshot` | — | save PNG, return the file path |
| `close` | `targetId` (default active) | close a tab |
| `shutdown` | — | stop the session process |

### Ergonomic model: snapshot → ref → act
```powershell
$sn = Post @{cmd='snapshot'}
$sn.items | ForEach-Object { "  $($_.ref) [$($_.tag)] $($_.text)" }   # read the list, pick a ref
Post @{cmd='click'; ref='e3'}
Post @{cmd='type';  ref='e2'; text='hello'}
```
Refs are injected on the elements as `data-opencode-ref`. A fresh `snapshot` re-tags them. Act promptly — refs are stable until the DOM changes or you re-snapshot.

### DOM boundaries: shadow roots and iframes
- `snapshot`, `text`, and ordinary `document.querySelector` operate on the top-level document. They can miss controls inside **shadow roots** (notably `edge://settings`) and content inside **iframes** (notably eBay's seller description). An empty snapshot does not prove the page has no controls.
- For open shadow roots, use `eval` to descend through each `element.shadowRoot` and inspect the rendered controls; interact with the actual control and re-read its selected value to verify. For example, Edge's search-engine picker is a `settings-select` inside nested shadow roots. `text` may be empty there.
- For iframe content, inspect `document.querySelectorAll('iframe')` for the frame URL. Read that URL in the browser (or a read-only fetch) before relying on a listing's description. On eBay, the description may be served from `itm.ebaydesc.com` and is **not** included in the item's top-level `text` response.
- For live listings, open the individual item page and confirm its current price, availability, condition, and seller description; search-result cards and Shopping prices can be stale or omit “for parts” details.

## Typical task flow
1. Launch + `Wait-Ready` (once).
2. `create` a tab, or use an existing tab id from `targets`; then `attach`.
3. `navigate` to the URL; wait a few seconds for load.
4. `snapshot` → read refs → `click`/`type`/`press_key` as needed.
5. `text` / `eval` / `screenshot` to read the result.
6. `close` the tab when done (or leave it open).

## Login with a saved account
You **cannot** read the stored password (App-Bound v20 — browser-only). Use division of labor:
1. `navigate` to the login page; `snapshot` to map the username field, password field, and submit button.
2. **User** clicks the username field and picks their account from Edge's autofill dropdown — the browser fills username + password securely (the secret never leaves the browser).
3. **Agent** `click`s the submit button, then verifies the result (`eval` on `location.href` / re-`snapshot`).
Never try to print the password; there is nothing to print.

## Troubleshooting
- **`GET /json/version` returns 404** — expected. In-browser remote debugging exposes the `ws://` endpoint from `DevToolsActivePort`, not the HTTP `/json` API. Never probe `/json`.
- **Session won't connect** — confirm "Allow remote debugging" is on. The wait loop auto-proceeds once the user grants the permission prompt.
- **Tab count differs from what the user sees** — raw CDP `Target.getTargets` (via `targets`) is the authoritative count of page targets; the set changes live as tabs open/close.
- **A prompt on a *different* tab is expected** (first attach to that tab); subsequent operations on the same tab are silent.
- **Page looks empty after `navigate`** — SPAs need a few seconds; re-check `title`/`text` after a short wait.
- **`Session with given id not found` after a tab closes** — call `targets` and `attach` to a live page; the active tab's prior session is gone. `targets` returns an array, and `create` returns an object: use `(Post @{cmd='create'; url=$url}).targetId` for `attach`.
- **Garbled non-ASCII (CJK/emoji) in output** — two halves, both now handled: (1) `cdp.mjs` sends `Content-Type: application/json; charset=utf-8`, so `Invoke-RestMethod` decodes the response as UTF-8 instead of Latin-1 (without it you see `ä½ å¥½` / `Â ` mojibake). (2) Set `[Console]::OutputEncoding = [Text.Encoding]::UTF8` (the snippets do) so PowerShell writes the decoded string to stdout as UTF-8 instead of the console code page (without it you see `?`). If still mangled, save the result (`| Out-File out.txt -Encoding utf8`) and read it with the Read tool.
- **`EADDRINUSE` in `cdp.log`** — a previous session still holds port 9333. New `cdp.mjs` detects this and exits 0 (adopts the existing session). If it was an older build, the port-owning process is authoritative: find it with the `Get-PortPid` pattern and update `cdp.pid`.
- **Tool call hangs / "opencode still showing running" when launching the session** — the shell tool waits on a Job Object (process tree); any descendant daemon keeps it open until timeout. Do NOT "simplify" launch.ps1 back to `Start-Process` — the `CREATE_BREAKAWAY_FROM_JOB` flag in `launch.ps1` is what makes the launch return. After launch, keep `Wait-Ready` running as the active command so the agent regains control the moment the user grants the Edge prompt.

## Files
- `launch.ps1` — starts `cdp.mjs` with `CREATE_BREAKAWAY_FROM_JOB` so the opencode tool call returns instantly (opencode waits on a Job Object; a non-breakaway daemon hangs the tool until timeout). No-ops + self-heals `cdp.pid` if a session already owns the port.
- `cdp.mjs` — the persistent session (self-contained, no dependencies). Rewrites `cdp.pid` with its own pid once it owns the port; exits 0 (adopt) if a healthy session already holds the port; sends `charset=utf-8` on all JSON responses; when `CDP_DETACHED=1` (set by launch.ps1) routes console output + fatal errors to `cdp.log` since it has no console.
- `cdp.pid`, `cdp.log`, `shot_*.png` — runtime artifacts (safe to delete). `cdp.pid` is best-effort; the port is authoritative.
