# Windows Portability Plan

**Goal:** Make OpenTack work on Windows without regressions on Linux/macOS.

**Strategy:** Bun is cross-platform. The blockers are our Unix shell assumptions in `execSync`, hardcoded `$HOME` paths, and `/proc/` filesystem access.

---

- [x] **Phase 1** — Shared paths utility (`src/paths.ts`)
- [x] **Phase 2** — Replace inline paths across codebase
- [x] **Phase 3** — Cross-platform git commands (no `2>/dev/null`, `rm -rf`, `find`)
- [x] **Phase 4** — Fix `isSessionAlive()` (platform-conditional `/proc/` on Linux only)
- [x] **Phase 5** — Fix process signals (no changes needed — Bun handles cross-platform)
- [x] **Phase 6** — Fix installer: bash spawns → error on Windows with manual-install guidance
- [x] **Phase 7** — Fix installer: `which`/`uname`/`mkdir -p` → `where`/`process.platform`/`mkdirSync`
- [x] **Phase 8** — Fix installer: GStreamer/sudo (already gated behind `process.platform === "linux"`)
- [x] **Phase 9** — Deprecate `opentack.sh` for Windows (added `opentack.bat` + Unix-only header)
- [x] **Phase 10** — Fix UI path strings (already cross-platform — uses `path.resolve`)
- [x] **Phase 11** — Fix `dev:hot` npm script (replaced bash-isms with `scripts/dev-hot.ts`)
- [x] **Phase 12** — Add Windows/Linux icons in `electrobun.config.ts` (all 3 generated in `assets/`)

---

## Phase 1 — Shared paths utility

Create one source of truth for all file paths. Replace `process.env.HOME` (undefined on Windows) with `os.homedir()` (works everywhere). Consolidate 3 duplicate implementations.

**Files created:** `src/paths.ts`
**Files modified:** none yet (Phase 2 does that)
**Verification:** `tsc --noEmit` passes

---

## Phase 2 — Replace inline paths

Import `src/paths.ts` in every file that hardcodes a path.

**Files to modify:**
- `src/db/index.ts` — `process.env.HOME` → `getOpenTackDbPath()`
- `src/bun/handlers/index.ts` — 8 inline paths → path functions
- `src/server/routes/cost-utils.ts` — hardcoded opencode DB path
- `src/server/routes/opencode-config.ts` — replace own `getConfigDir()` with shared
- `src/server/routes/session.ts` — replace own `getOpencodeConfigPath()` with shared
- `src/server/routes/worktree.ts` — `process.env.HOME || "/home"`
- `src/server/routes/repo.ts` — `process.env.HOME || "/home"`
- `src/installer/index.ts` — `Bun.env.HOME` → `os.homedir()`

**Verification:** App starts on Linux with no path regression. DB and config files resolve to same locations.

---

## Phase 3 — Cross-platform git commands

Replace all `execSync()` shell strings with Bun cross-platform equivalents. Remove `2>/dev/null`, `|| true`, `;`, `rm -rf`, `find` from shell commands.

**Pattern replacements:**
- `2>/dev/null` → try/catch
- `rm -rf` → `fs.rmSync({ recursive, force })`
- `find ...` → `fs.readdirSync` recursive walk
- `2>/dev/null || echo "no"` → try/catch + boolean
- `2>/dev/null | head -1` → try/catch + `.split('\n')[0]`

**Files to modify:** `worktree.ts`, `repo.ts`, `ticket.ts`, `session.ts`, `handlers/index.ts`
**Verification:** Every git command runs without shell metacharacters. Error suppression works via try/catch.

---

## Phase 4 — Fix `isSessionAlive()`

Replace `/proc/$pid/` filesystem access with cross-platform `process.kill(pid, 0)` + port check. Keep `/proc/` checks on Linux where available, fall back to process.kill on Windows/macOS.

**File:** `src/server/opencode-manager.ts`
**Verification:** Session health check works on all platforms.

---

## Phase 5 — Fix process signals

`process.kill(pid, "SIGTERM")` / `("SIGKILL")` — Bun's `ChildProcess.kill()` handles this. Verify and fix if needed.

**File:** `src/server/opencode-manager.ts`
**Verification:** Stopping a session kills the opencode process on Windows.

---

## Phase 6 — Fix installer: bash spawns

Replace `Bun.spawn(["bash", ...])` with platform-appropriate shell. Use Bun's `$.shell()` or auto-detect PowerShell on Windows.

**File:** `src/installer/index.ts`
**Verification:** Installer runs on Windows.

---

## Phase 7 — Fix installer: Unix commands

Replace `which` → `where`, `uname` → `process.platform`, `mkdir -p` → `fs.mkdirSync({ recursive })`.

**File:** `src/installer/index.ts`
**Verification:** Binary detection (`bun`, `opencode`, `git`) works on Windows.

---

## Phase 8 — Fix installer: GStreamer/sudo

Guard GStreamer step with `process.platform === "linux"`. Skip entirely on Windows/macOS.

**File:** `src/installer/index.ts`
**Verification:** No sudo call on Windows. GStreamer only installed on Linux.

---

## Phase 9 — Deprecate `opentack.sh` for Windows

Add header note: "Windows users: use `opentack-install.exe` instead."

**Files:** `opentack.sh`, `README.md`
**Verification:** Clear guidance for Windows users.

---

## Phase 10 — Fix UI path strings

Replace hardcoded `~/.config/opencode/tui.json` in Settings UI with actual resolved path.

**File:** `src/client/components/Settings.tsx`
**Verification:** Settings page shows correct path on Windows.

---

## Phase 11 — Fix `dev:hot` npm script

Replace bash-ism (`&` background, `while sleep`) with cross-platform approach.

**File:** `package.json`
**Verification:** Dev workflow documented for Windows.

---

## Phase 12 — Add Windows/Linux icons

Add `win.icons` and `linux.icons` to `electrobun.config.ts`.

**File:** `electrobun.config.ts`
**Verification:** `electrobun build` succeeds with icon configs.

---

## Dependency graph

```
Phase 1 ─┬→ Phase 2
          │
Phase 3 ──┤
Phase 4 ──┤
Phase 5 ──╯
          │
Phase 6 ──┬→ Phase 7 ──┬→ Phase 8
          │              │
Phase 9 ──╯              │
                         │
Phase 10 ←───────────────╯
Phase 11 ←───────────────╯
Phase 12 ←───────────────╯
```

Phases run sequentially within each parallel group. Phase 1 must finish before Phase 2.
