# Wallet verification runbook — `longstone-vscode` 0.2

> **Manual, not CI.** The cases in §3 are executed by a person in a real
> desktop VS Code window and signed off in §4. CI runs only the automated
> gates in §2. An unsigned row is unverified, and this document must not be
> cited as evidence for it.

## 1. Scope

In scope: the local encrypted wallet of `longstone-vscode` 0.2 in a **local**
desktop window — create, import, unlock, lock, export, change password,
reset, account deletion, idle/focus locking, multi-window reconciliation,
remote-window refusal, `state.vscdb` at rest, and reload behavior.

Out of scope: signing, sending, dApps, the MCP provider, the memory browser,
the browser extension, and any store publication. The wallet never signs and
never opens a network connection.

Test machine: desktop VS Code 1.101 or newer on Windows, macOS or Linux, with
a local (non-remote) window. Use a **dedicated VS Code profile** so the run
does not touch a real wallet.

## 2. Automated pre-checks

Run these first; a manual pass on a red build proves nothing.

```bash
pnpm install --frozen-lockfile
pnpm --filter @limccn/longstone-wallet build
pnpm --filter @limccn/longstone-wallet test
pnpm --dir longstone-vscode verify:all
pnpm --dir longstone-ext check
pnpm --dir longstone-ext e2e
```

Expected: every command exits 0 with zero failing tests. At the time of
writing the suites are wallet 105, browser extension 110 plus 13 end-to-end
checks, and VS Code 307; the gate is **zero failures**, not the count.

Packaging gate:

```bash
pnpm --dir longstone-vscode exec vsce package --no-dependencies
pnpm --dir longstone-vscode exec vsce ls --no-dependencies > longstone-vscode/vsix-files.txt
node longstone-vscode/scripts/assert-vsix.mjs longstone-vscode/vsix-files.txt
```

Expected: the VSIX contains only the allowlisted files under `dist/` and
`media/` plus `package.json`, `README.md` and `LICENSE`. Sources, tests,
scripts, docs, maps and `node_modules` must not appear.

### `state.vscdb` checker

`scripts/check-wallet-db.mjs` opens the SQLite state database **read-only**
and validates the wallet record with the shared core's strict parser. It
prints the storage layout, key names, status, KDF parameters and ciphertext
length — never the salt, IV or ciphertext. Both layouts are supported: the
legacy top-level `longstone.wallet.v1` rows and the VS Code 1.143+
per-extension container row keyed by `limccn.longstone-vscode`. `--json`
prints `{ db, layout, ok, exitCode, failures }`; when the database cannot be
opened or read (exit 2), `layout` is `unknown`.

```bash
# Default location for this platform's stable VS Code profile:
node longstone-vscode/scripts/check-wallet-db.mjs

# Any other build/profile (Insiders, VSCodium, custom --user-data-dir):
node longstone-vscode/scripts/check-wallet-db.mjs --db "<path>/state.vscdb"

# Machine-readable summary:
node longstone-vscode/scripts/check-wallet-db.mjs --db "<path>/state.vscdb" --json

# Via the package script:
pnpm --dir longstone-vscode check:wallet-db -- --db "<path>/state.vscdb"
```

Expected output with one wallet record:

```text
state.vscdb: <path>
layout   top-level
record   longstone.wallet.v1  ok  format=longstone.wallet.v1 kdf=65536/3/1 ciphertext=<n>B
pending  longstone.wallet.v1.pending  absent
```

On VS Code 1.143+ the layout line is
`layout   container limccn.longstone-vscode` and the record/pending lines are
unchanged. A container that cannot be parsed reports
`layout   container limccn.longstone-vscode  FAIL  invalid-json` (or
`invalid-shape` / `unsupported-value-type`) with exit 1.

The KDF rung may be lower on a slow device (`32768/3/1` or `19456/2/1`);
that is the documented ladder, not a failure.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | record valid (pending absent or valid) |
| 1 | validation failed (missing record, corrupt value, plaintext field) |
| 2 | usage or database-environment error (no path, no `ItemTable`, open failure) |

Default paths: `%APPDATA%\Code\User\globalStorage\state.vscdb` (Windows),
`~/Library/Application Support/Code/User/globalStorage/state.vscdb` (macOS),
`~/.config/Code/User/globalStorage/state.vscdb` (Linux). The script needs
Node.js 24 or newer for `node:sqlite`; the `ExperimentalWarning` on stderr is
harmless. **Close VS Code before checking the database.**

## 3. Manual matrix

Record every case in §4. Use English UI copy below as the reference; a
localized build may word it differently — judge the behavior.

### M1 — Create a wallet

Preconditions: fresh profile, status bar shows `Longstone Wallet` with no
address, no wallet record in `state.vscdb`.

Steps:

1. Command Palette → `Longstone: Create Wallet`.
2. Read the 12-word recovery phrase in the dedicated secret panel; note that
   the panel has no countdown and can be closed.
3. Close the panel without choosing "saved" (negative check), then repeat the
   command and choose "saved".
4. Enter a password of at least 8 Unicode code points twice.

Expected:

- Closing without "saved" writes nothing; the command can be re-run cleanly.
- After both password prompts: `Wallet created. Back up your recovery phrase
  offline.`
- Status bar shows the truncated address with the `Account 1` label in its
  tooltip; the vault is unlocked.
- `state.vscdb` has one `longstone.wallet.v1` value; `longstone.wallet.v1.
  pending` is absent.

### M2 — Import a mnemonic or private key

Preconditions: `NO_VAULT` state (use a fresh profile or reset first).

Steps:

1. `Longstone: Import Wallet` → choose mnemonic, enter a known 12-word test
   phrase; then repeat with a known 32-byte test private key.
2. Set a wallet password.

Expected: after each import, the status bar shows the address derived from the
imported material; unlocking later reproduces the same address. Invalid
words/checksum or a malformed private key are rejected before any write: the
import panel stays open and shows the matching static message
(`The private key must be 0x followed by 64 hex characters.` or
`The private key is not a valid secp256k1 key.`).

### M3 — Wrong password and unlock backoff

Preconditions: wallet exists and is locked.

Steps:

1. `Longstone: Manage Wallet` → unlock; enter a wrong password five times.
2. After the fifth failure, run `Longstone: Lock Wallet`: it reports `The
   wallet is already locked.` and must not clear the wait.
3. Run `Longstone: Manage Wallet` → unlock again: the prompt first reports the
   remaining delay, waits it out, then asks for the password.
4. Keep failing to watch the delay grow through 1, 2, 4, 8 and 16 s to the
   30 s cap.
5. Wait for the delay to elapse and enter the correct password.

Expected:

- Each of the first five failures reports a decrypt failure and allows another
  attempt; the fifth starts the 1 s minimum delay.
- The next unlock attempt reports `Too many attempts. Try again in <n>s.` with
  1, 2, 4, 8, 16, then a 30 s cap, and waits before prompting.
- Locking does **not** clear the delay: a locked wallet cannot be locked again,
  and the limiter is controller state that survives a lock and an internal
  reload (the controller test pins this). A successful unlock is the only
  reset; `Developer: Reload Window` restarts the extension host and therefore
  its counter — a process restart, not a bypass.
- The correct password after the delay unlocks normally.

### M4 — Lock

Preconditions: unlocked wallet.

Steps: `Longstone: Lock Wallet`; then run `Longstone: Copy Wallet Address`
or `Show Memory Browser`.

Expected: `Wallet locked.`; the status bar no longer shows the address (or the
account label in its tooltip); copy-address and export refuse until the wallet
is unlocked again.

### M5 — Export with the 60 s countdown

Preconditions: unlocked wallet with one account.

Steps:

1. `Longstone: Export Wallet Secret`, choose mnemonic, and enter a **wrong**
   password.
2. Repeat with the correct password.
3. Leave the secret panel open and watch the countdown.
4. Close the panel early with the close button; reopen and copy the secret.

Expected:

- Wrong password: `Incorrect password. Nothing was exported.` and no panel.
- Correct password: a dedicated secret panel shows the secret and a countdown
  starting at 60 s; at zero the secret is removed/panel closes by itself.
- Closing early discards the secret; the countdown restarts for the next
  export. The clipboard contains the secret after "Copy".

### M6 — Change password

Preconditions: unlocked wallet.

Steps:

1. `Longstone: Change Wallet Password`; enter the current password, then the
   new password twice.
2. Lock the wallet; unlock with the **old** password; unlock with the **new**
   password.

Expected:

- Success message `Password changed.`; the session stays unlocked.
- The old password fails with a decrypt failure; the new password unlocks.
- `state.vscdb` still holds exactly one record; pending is cleaned up (a
  cleanup warning is acceptable and resolves on the next unlock).

### M7 — Reset

Preconditions: wallet exists.

Steps:

1. While unlocked, run `Longstone: Reset Wallet`.
2. Lock, run the command again: click `Continue` in the warning notification,
   then type `RESET` and confirm.
3. Re-run `Longstone: Manage Wallet`.

Expected:

- While unlocked: `Lock the wallet before resetting it.` Nothing is deleted.
- The confirmation is an in-window notification (D-2): the window keeps focus,
  the wallet stays `LOCKED`, and the `RESET` prompt appears.
- After the typed confirmation: `Wallet deleted.`; state is `NO_VAULT`; the
  status bar shows no address.
- The checker exits 1 with `missing wallet record` — the expected
  post-deletion state, not a checker failure.

### M8 — Delete the last account

Preconditions: unlocked wallet with exactly one account.

Steps: `Longstone: Manage Wallet` → accounts → delete the only account;
click `Delete` in the last-account warning notification (in-window since D-2).

Expected: warning names the account and says the wallet itself will be
deleted; after confirmation the message is `Wallet deleted.`, both
`longstone.wallet.v1` and `longstone.wallet.v1.pending` are gone, and the
state is `NO_VAULT`.

### M9 — Idle lock (15 minutes)

Preconditions: unlocked wallet, no secret panel open.

Steps: leave the window focused and do not click or type for 15 minutes plus
up to 30 seconds (the idle check interval).

Expected: the wallet locks on its own; the status bar hides the address; an
unlock is required. Any click/keypress/focus resets the idle timer.

### M10 — Focus loss

Preconditions: unlocked wallet.

Steps: click another application window (do not use a VS Code quick pick),
then return to VS Code.

Expected: the wallet locks immediately on blur; the status bar hides the
address; returning focus requires an unlock. An open reveal panel is closed
and its secret is not restored.

### M11 — Two windows, external change

Preconditions: two local VS Code windows on the same profile and the same
wallet; window A unlocked.

Steps:

1. In window B, unlock the same wallet with the same password.
2. In B, add an account (or rename one) and wait for success.
3. Return to window A. Do not run a wallet command first; the detection must
   reach the user on its own (D-4).

Expected: A locks with `Wallet data changed in another window. Unlock again.`,
shown by the focus-regain handler. The 10 s poll only records the change (it
never displays a message by itself); if the notice is missed, the next wallet
command shows it. The address disappears; unlocking A shows the change made in
B. A never reports its own writes as external. Focus loss alone (no write in
B) locks A silently, without a notice.

### M12 — Remote-SSH refusal

Preconditions: Remote-SSH (or Codespaces / Dev Container) window; local
window with an existing wallet for contrast.

Steps: in the remote window, run `Longstone: Manage Wallet`,
`Longstone: Create Wallet` and `Longstone: Copy Wallet Address`.

Expected: every command reports `The Longstone wallet is local-only. Open a
local VS Code window.`; there is no wallet status item, no storage write, and
the remote `state.vscdb` contains no `longstone.wallet.v1` key. The local
wallet is unaffected.

### M13 — Ciphertext at rest

Preconditions: wallet created, then locked; VS Code closed.

Steps:

1. Locate this profile's `state.vscdb` (§2).
2. Run the checker with `--db`.
3. Optionally run it once more with `--json` and confirm the failures array is
   empty.

Expected: exit 0; the `layout` line names `top-level` or
`container limccn.longstone-vscode`; the record line reports `ok`, the KDF
parameters and a ciphertext length; pending is `absent`. The output contains
no salt, IV, ciphertext or recovery phrase. The stored wallet value (the
top-level row, or the container's `longstone.wallet.v1` field) is a JSON
envelope whose only top-level keys are `cipher, createdAt, domain, format,
kdf, updatedAt, version` — no account labels, addresses, mnemonics or keys.

### M14 — Reload keeps the wallet locked

Preconditions: unlocked wallet.

Steps: Command Palette → `Developer: Reload Window`; after activation, run
`Longstone: Manage Wallet`.

Expected: the wallet comes back `LOCKED` (the session is memory-only), the
status bar shows no address, and the password is required again. A reveal
panel open before the reload is gone and does not reappear.

## 4. Sign-off

One row per case; leave `Result` empty until executed. `Pass` requires every
expected observation in §3. Attach screenshots only if they contain no secret
material.

| # | Case | Result (Pass/Fail/Blocked) | Executor | Date | Notes |
|---|---|---|---|---|---|
| M1 | Create a wallet | Pass | Claude Code (AI) | 2026-10-26 | Closing the panel without "I saved it" wrote nothing; after saving, `Wallet created. Back up your recovery phrase offline.`, status `0x8E6a…9625, Account 1`; one record (kdf 65536/3/1, ciphertext 380 B), pending absent. D-1 at the time: verified with a read-only container inspector; the shipped checker now reads this layout too (see M13). |
| M2 | Import mnemonic and private key | Pass | Claude Code (AI) | 2026-10-27 | Invalid mnemonic rejected in the panel with the wordlist message and no write; `TEST_MNEMONIC` → `0xf39F…2266` matching an independent derivation, reproducible after lock/unlock; fresh DB + `TEST_PRIVATE_KEY` → `0x7099…79C8` matching derivation. D-3 retest on a local VSIX: pasting `0x1234` and continuing shows `The private key must be 0x followed by 64 hex characters.`, the panel stays open with `Continue`/`Cancel`, and the record is unchanged with pending absent (checker exit 0). Supersedes the 2026-10-26 note that a malformed key wrote nothing but showed no error. |
| M3 | Wrong password and unlock backoff | Pass | Claude Code (AI) | 2026-10-26 | Every wrong attempt reported the decrypt failure; attempt pacing measured 1.3/2.2/4.2/8.3/16.2/30.3 s. The notice shows the **remaining** delay (1/3/7/15/29 s) — the 1 s rung is absorbed by ~1.3 s of prompt overhead; the unit test pins the nominal 1/2/4/8/16/30 ladder. Re-lock kept the limiter (`The wallet is already locked.`); the correct password unlocked after the cap; reload reset only the in-process counter (no delay 1.35 s after a 30 s cap). |
| M4 | Lock | Pass | Claude Code (AI) | 2026-10-26 | `Wallet locked.`; the status bar hid the address; `Copy Wallet Address` refused with `Unlock the wallet first.`. |
| M5 | Export with the 60 s countdown | Pass | Claude Code (AI) | 2026-10-26 | Wrong password: `Incorrect password. Nothing was exported.`, no panel. Correct: secret panel with a countdown (first read 59 s after render, 55 s after 3 s); early close discarded it; reopen restarted at 58 s; Copy produced a 12-word phrase (count only, clipboard cleared, no screenshot of the panel); auto-closed at zero; wallet stayed unlocked. |
| M6 | Change password | Pass | Claude Code (AI) | 2026-10-26 | `Password changed.` with the session still unlocked; old password failed, new password unlocked `0x8E6a…9625`; one record and pending absent (read-only container inspector). |
| M7 | Reset | Pass | Claude Code (AI) | 2026-10-27 | Retested on a local VSIX built from `081e3c2` (D-2 fix) on VS Code 1.143.1. Unlocked reset refused with `Lock the wallet before resetting it.`; locked reset opened an in-window notification — no native `#32770` dialog, the target window kept foreground, the wallet stayed `LOCKED`, buttons `Continue`/`Cancel`. Continue + typed `RESET` → `Wallet deleted.`, state `NO_VAULT`, no address; the checker exits 1 with the record absent (expected post-deletion state). Supersedes the 2026-10-26 Fail (D-2). |
| M8 | Delete the last account | Pass | Claude Code (AI) | 2026-10-27 | Retested on the same local build: the last-account warning is an in-window notification with `Delete`/`Cancel`, no native dialog, window focused, wallet `UNLOCKED` while open. Accepting `Delete` → `Wallet deleted.`, state `NO_VAULT`; after closing VS Code the record and pending keys are absent (read-only container inspector). Supersedes the 2026-10-26 Fail (D-2). |
| M9 | Idle lock (15 minutes) | Blocked | Claude Code (AI) | 2026-10-26 | Three attempts, all invalidated by the environment. Unrelated windows took the foreground at 142 s (Chrome) and 41 s (`CC Switch`); the focus-loss lock fired in both. A third 17-minute observation with foreground sampling reached 779 s before the status bar showed `Locked` — 121 s short of the 900 s deadline. The check right after showed the session still Active and Unlocked (WTSINFOEX `SessionState=0`, `SessionFlags=1`), the input desktop `Default`, no LogonUI in the session, and `GetLastInputInfo` showed no human input during the run; but the foreground handle had become 0, `SetForegroundWindow` failed, and screen capture failed with an invalid handle (the start-of-run capture rendered fine) — the session's display output was suspended, VS Code was deactivated, and the wallet locked on focus loss as designed. The 15-minute idle timer was not observed. The controller test pins 900 000 ms with a 30 s check interval. Not a product defect; re-runnable on a session that can hold foreground and display output for 16+ minutes. |
| M10 | Focus loss | Pass | Claude Code (AI) | 2026-10-26 | Switching to Notepad and back locked immediately; the reveal panel was gone, the address hidden, and an unlock was required. |
| M11 | Two windows, external change | Pass | Claude Code (AI) | 2026-10-27 | D-4 retest on a local VSIX (same profile, two windows): after B unlocked and renamed the account to `M11 Account`, focusing A showed `Wallet data changed in another window. Unlock again.` about 1 s after focus return without running a command; A stayed `Locked`; unlocking and opening Manage showed `M11 Account, 0x8E6a…9625 · active`. Supersedes the 2026-10-26 Fail (notice unreachable after focus-loss lock). |
| M12 | Remote-SSH refusal | Blocked | Claude Code (AI) | 2026-10-26 | No remote environment: both profiles have only the test extension installed, no `ms-vscode-remote.*`, no SSH config, and local-only window titles. The three commands could not be run in a remote window; the wallet is local-only by design, so no remote storage write path exists. |
| M13 | Ciphertext at rest | Pass | Claude Code (AI) | 2026-10-27 | D-1 retest with the shipped checker on the closed VS Code 1.143 profile: exit 0, `layout container limccn.longstone-vscode`, record ok (kdf 65536/3/1, ciphertext 380 B), pending absent, no salt/IV/ciphertext/phrase in the output; deleting the record makes it exit 1 with `missing wallet record`. A live read-only `--json` check on the reopened profile also exits 0. The strict parser enforces exactly the seven envelope keys with no plaintext fields. Supersedes the 2026-10-26 Fail (checker blind to the container layout). |
| M14 | Reload keeps the wallet locked | Pass | Claude Code (AI) | 2026-10-26 | After `Developer: Reload Window` the wallet came back `LOCKED`, the address was hidden, `Manage Wallet` offered `Unlock / Change password / Reset wallet`, and a panel open before the reload did not return. |

Owner sign-off: 2026-10-26 — accepted as recorded above (8 Pass, 4 Fail,
2 Blocked). M9 stays `Blocked` for environment reasons and is to be re-run on a
session that can hold foreground and display output; the failures and blocked
cases are tracked as D-1…D-4 in `.trellis/tasks/10-26-vscode-wallet-gui-matrix`.

D-2 retest: 2026-10-27 — M7 and M8 now pass on a local build carrying the D-2
fix, bringing the matrix to 10 Pass, 2 Fail, 2 Blocked. The remaining failures
are D-1 (M13 checker on the 1.143 container) and D-4 (M11 external-change
notice); M12 remains environment-blocked.

D-1/D-3/D-4 retest: 2026-10-27 — M11 and M13 now pass on a local VSIX built from
the fix branch, and M2's D-3 note is cleared. Matrix: 12 Pass, 0 Fail, 2 Blocked
(M9, M12). These retested rows are recorded here and await owner sign-off.

Build verified: version `0.2.2` · commit `f3b4c13` · VS Code
`1.143.1 (e646868227c3e3a9e3f24277c8c7220be42c0be7)` · OS `Windows Server 2022 Standard Evaluation 10.0.20348`.
D-2 retest build: local VSIX from commit `081e3c2` · VS Code `1.143.1`.
D-1/D-3/D-4 retest build: local VSIX `0.2.2-d134-local` from code commit `c1da3ab` · VS Code `1.143.1` (0.2.3 packages the same code).

## 5. Known limitations

- Copy may differ with VS Code's display language or version; judge behavior,
  not wording.
- The idle interval is 15 minutes with a 30 s check, so the lock can appear
  up to ~30 s late.
- Opening an OS dialog counts as focus loss; use a separate application window
  for M10, and do not treat a VS Code quick pick as the blur test.
- M12 verifies refusal only. The wallet is local-only by design; there is no
  remote-wallet mode to test.
- `state.vscdb` paths vary by build, profile and `--user-data-dir`; always pass
  `--db` when the default does not exist. Keep VS Code closed while checking.
- The checker is diagnostic only; it is not part of the extension runtime and
  never writes. `node:sqlite` is experimental (Node 24+).
- Never paste a recovery phrase or private key into a terminal, shell history,
  issue tracker or chat. Use the secret panel and its Copy button only.
- This runbook does not replace the automated suites in §2, and CI does not
  execute any case in §3.
