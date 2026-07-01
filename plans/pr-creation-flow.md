# PR Creation Flow

Automate commit + push + PR creation when submitting a ticket for review, using opencode SDK to generate commit messages and `gh` for GitHub operations.

## Two Phases

- **Phase 1**: Integrate gh CLI into the app (settings, auth, detection, shared runner)
- **Phase 2**: PR creation flow on top of Phase 1

---

# Phase 1: gh CLI Integration

Make `gh` a first-class tool in the app — settings page, token storage, detection, and a shared runner any feature can use.

## Architecture

```
┌─────────────┐     POST /api/gh/run      ┌──────────────────┐
│  Client UI   │ ──────────────────────→   │  Backend Handler  │
│  Settings    │                           │  (gh-integration) │
│  Test btn    │ ←──────────────────────   │                  │
└─────────────┘     { stdout, stderr }     │  • reads token    │
                                           │    from settings  │
                                           │  • validates gh   │
                                           │    path           │
                                           │  • spawns gh with │
                                           │    GH_TOKEN env   │
                                           └──────────────────┘
```

## Settings

### Schema (global settings, stored in `settings` table)

```typescript
interface GhSettings {
  ghPath: string         // default "gh" — path to gh binary
  ghToken: string        // GitHub PAT, stored encrypted
  defaultRemote: string  // default "origin"
}
```

### Settings Page UI

New "GitHub" section in settings. Uses the existing `SectionCard` pattern.

#### State: gh not installed

```
┌──────────────────────────────────────────────┐
│  GitHub <GitHub icon>                         │
│  Connect your GitHub account to create PRs    │
│  and manage repos.                            │
│                                               │
│  ┌──────────────────────────────────────────┐ │
│  │  ⚠ gh CLI not found                      │ │
│  │                                          │ │
│  │  Install GitHub CLI to enable PR         │ │
│  │  creation and other GitHub features.     │ │
│  │                                          │ │
│  │  Linux:   sudo apt install gh            │ │
│  │  macOS:   brew install gh                │ │
│  │  Windows: winget install --id GitHub.cli │ │
│  │                                          │ │
│  │  gh CLI Path: [gh                    ]   │ │
│  │                                          │ │
│  │  [Install gh automatically]              │ │
│  │  [I installed it — check again]          │ │
│  └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

#### State: gh installed, not authenticated

```
┌──────────────────────────────────────────────┐
│  GitHub                                        │
│  Connect your GitHub account to create PRs     │
│                                                │
│  gh CLI Path:  [gh                     ]  ✓    │
│  ──────────────────────────────────────────    │
│  Personal Access Token:  [••••••••••••••]      │
│  (requires `repo` scope — create one at        │
│   github.com/settings/tokens)                  │
│  ──────────────────────────────────────────    │
│  Default Remote:  [origin              ]      │
│                                                │
│  [Test Connection]                             │
└──────────────────────────────────────────────┘
```

#### State: authenticated

```
┌──────────────────────────────────────────────┐
│  GitHub                                        │
│  Connected to GitHub as anas1412              │
│                                                │
│  ┌──────────────────────────────────────────┐ │
│  │  [avatar]  anas1412                      │ │
│  │           anas@example.com               │ │
│  │           Token: repo, read:org ✓        │ │
│  │           Plan: Free                     │ │
│  └──────────────────────────────────────────┘ │
│                                                │
│  gh CLI Path:  [gh                     ]  ✓    │
│  ──────────────────────────────────────────    │
│  Personal Access Token:  [••••••••••••••]      │
│  ──────────────────────────────────────────    │
│  Default Remote:  [origin              ]      │
│                                                │
│  [Re-test Connection]         [Disconnect]     │
│  ✓ Last checked: 2 minutes ago                │
└──────────────────────────────────────────────┘
```

#### Profile info fetched from `gh api user`

When authenticated, fetch these from GitHub API via gh:

```bash
gh api user --jq '{login, name, email, avatar_url, plan}'
gh api user --jq '.plan.name'   # Free / Pro / Enterprise
```

Returns:
```json
{
  "login": "anas1412",
  "name": "Anas",
  "email": "anas@example.com",
  "avatar_url": "https://avatars.githubusercontent.com/u/...",
  "plan": "Free"
}
```

Also check token scopes via `gh api rate_limit` (returns headers showing scopes).

Display in Settings:
- **Avatar** (24px circle, from `avatar_url`)
- **Username** (`login`)
- **Email** (if public)
- **Scopes** (from token — `repo`, `read:org`, etc.)
- **Plan** (Free/Pro/Enterprise)

#### Disconnect button

Clears the stored token from settings. Resets profile display to "not authenticated" state.

### Token Storage

- Store token encrypted in SQLite settings row using `Bun.password.hash` with bcrypt or a simple AES encryption
- Decrypt in memory only when spawning gh — never logged, never returned to client
- Client sends `token: "••••••••"` placeholder back; real token only written, never read by client

## Shared gh Runner

File: `src/shared/gh-runner.ts`

```typescript
interface GhRunOptions {
  args: string[]           // e.g. ["pr", "create", "--title", "..."]
  cwd?: string             // working directory for the command
}

interface GhRunResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function runGh(options: GhRunOptions): Promise<GhRunResult>
async function testGhConnection(): Promise<{ ok: boolean; user?: string; error?: string }>
```

**`runGh` behavior:**
1. Read `ghPath`, `ghToken` from settings
2. Validate gh binary exists (`which/where gh`), throw clear error if not
3. Validate token is set, throw clear error if empty
4. Spawn `Bun.spawn([ghPath, ...args], { cwd, env: { GH_TOKEN: decryptedToken } })`
5. Return stdout, stderr, exitCode

**`testGhConnection` behavior:**
1. `runGh({ args: ["auth", "status"] })`
2. Parse `stdout` for logged-in username
3. Return `{ ok: true, user: "anas1412" }` or `{ ok: false, error: "..." }`

## gh Not Installed — Handling

When `gh` is not found at the configured path, the app detects the OS and provides platform-specific guidance.

### Detection

```typescript
// Bun cross-platform which
async function findGh(path: string): Promise<string | null> {
  // Process.arch gives "x64" etc, process.platform gives "linux" | "darwin" | "win32"
  const isWin = process.platform === "win32";
  const cmd = isWin ? "where" : "which";
  const result = Bun.spawnSync([cmd, path]);
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}
```

### Auto-Install (Settings Page)

If `gh` is not found, the settings page shows an **Install gh** button instead of Test Connection.

Clicking it calls `POST /api/gh/install` which runs the install command for the detected OS:

| Platform | Command |
|----------|---------|
| Linux (Debian/Ubuntu) | `sudo apt install gh -y` |
| Linux (Fedora) | `sudo dnf install gh -y` |
| Linux (Arch) | `sudo pacman -S github-cli` |
| macOS | `brew install gh` |
| Windows | `winget install --id GitHub.cli -e` or `scoop install gh` |

**Install API:**

```
POST /api/gh/install
  → 200 { success: true, path: "/usr/bin/gh" }
  → 500 { error: "INSTALL_FAILED", message: "Could not install gh. Try manually:\n
          Linux:  sudo apt install gh\n
          macOS:  brew install gh\n
          Windows: winget install --id GitHub.cli" }
```

The endpoint checks `Bun.which("sudo")` / `Bun.which("brew")` / `Bun.which("winget")` to validate the package manager exists before running.

**Important**: `sudo` requires interactive password entry for some configs. Options:
  - Check if user has passwordless sudo (`sudo -n true`). If not, show manual instructions instead of running auto-install
  - On Windows/macOS (brew), no sudo needed — auto-install is safe

### Manual Install Instructions (Fallback)

When auto-install is not possible (no supported package manager, sudo requires password), show:

```
┌──────────────────────────────────────────────┐
│  gh CLI not found                             │
│                                               │
│  Install manually:                            │
│                                               │
│  Linux:  https://cli.github.com  │
│          sudo apt install gh                  │
│          sudo dnf install gh                  │
│                                               │
│  macOS:  brew install gh                      │
│          https://cli.github.com  │
│                                               │
│  Windows: winget install --id GitHub.cli      │
│           https://cli.github.com  │
│                                               │
│  Or set a custom path below if already        │
│  installed in a non-standard location.        │
│                                               │
│  gh CLI Path:  [gh                     ]      │
│                                               │
│  [Install gh] [I installed it manually]       │
└──────────────────────────────────────────────┘
```

### Validation API

```
POST /api/gh/test
  → 200 { ok: true, user: "anas1412" }
  → 400 { ok: false, error: "gh not found at path 'gh'" }
  → 400 { ok: false, error: "Not authenticated. Token has no `repo` scope." }
```

Called by:
- **Settings page** Test Connection button
- **Before any PR flow** to give early error instead of failing mid-flow

## gh Detection

- On startup, run `Bun.spawnSync(["which", ghPath])` to check
- Cache result (valid/invalid) per session
- If ghPath changes in settings, re-check
- Settings page shows green checkmark or red X next to gh path field

## API Endpoints (Phase 1)

```
POST /api/gh/test         — test gh + token auth
```

(Phase 2 adds `POST /api/tickets/:id/submit-for-review`)

## Files to Touch (Phase 1)

| File | Change |
|------|--------|
| `src/shared/gh-runner.ts` | **New** — shared `runGh`, `testGhConnection` |
| `src/shared/types.ts` | Add `ghPath`, `ghToken`, `defaultRemote` to settings |
| `src/db/schema.ts` | Ensure settings table supports these keys (likely already dynamic) |
| `src/server/routes/gh.ts` | **New** — `POST /api/gh/test` handler |
| `src/server/index.ts` | Register gh routes |
| `src/client/components/SettingsPage.tsx` | Add GitHub section with token field, test button |
| `src/shared/rpc.ts` | Add `"ghTest"` to RPC definitions |

---

# Phase 2: PR Creation Flow

Build on top of Phase 1's gh runner.

## Flow Overview

```
[Submit for Review] button
  │
  ├─ 1. Test gh connection  (early fail if gh broken)
  │
  ├─ 2. Check worktree for uncommitted changes
  │     (skip commit if clean)
  │
  ├─ 3. Get git diff → opencode SDK → generated commit message
  │
  ├─ 4. git add -A && git commit -m "{generated msg}" && git push
  │
  ├─ 5. gh pr create
  │
  ├─ 6. Stop session  (existing)
  │
  └─ 7. Set status → needs_review  (existing)
```

Each step stops on failure. Status and session left intact.

## Step Details

### Step 1: Pre-flight gh check

Call `gh auth status` via the shared runner. If it fails, return error immediately — no partial state.

### Step 2: Check for uncommitted changes

```bash
git -C {worktreePath} diff --quiet
```

Exit code 0 = clean → skip to PR creation. Exit code 1 = dirty → continue.

### Step 3: Generate commit message via opencode SDK

Use the **existing opencode session** already running for this ticket (port + opencodeSessionId known). One-shot `session.prompt()`:

**Prompt:**
```
You are a git commit message generator. Write a concise conventional commit message for the following diff.

Rules:
- First line: type(scope): short description (max 72 chars)
- Body: bullet points explaining what and why, wrapped at 72 chars
- Types: feat, fix, refactor, chore, docs, style, test, perf
- Do not include a blank line between the subject and the body

Diff:
```diff
{diff}
```
```

**Implementation notes:**
- Keep prompt in a shared constant
- Use SDK client from `opencode-client.ts`
- Message appears in session history — acceptable, it's part of the work
- Consider `json_schema` output for structured parsing (subject + body separately)

### Step 4: Commit and push

```bash
git -C {worktreePath} add -A
git -C {worktreePath} commit -m "{generated message}"
git -C {worktreePath} push {remote} {branch}
```

Remote from settings (`defaultRemote`, default `origin`).

### Step 5: Create PR via gh

```bash
gh pr create \
  --repo "{repo owner/name}" \
  --title "{ticket title}" \
  --body "{ticket description}\n\n{commit message}\n\n{git diff --stat}"
```

- **Draft** if status → `needs_review`, **ready** if → `resolved`
- `git diff --stat` appended to body for file summary

### Steps 6–7: Stop session + set status

Already implemented in `TicketDetail.tsx` — `onStopSession()` then `updateTicket.mutateAsync({ status })`.

## API Endpoint (Phase 2)

```
POST /api/tickets/:id/submit-for-review
  Body: { status: "needs_review" | "resolved" }
  → 200 { success: true, prUrl: "https://github.com/.../pull/123" }
  → 400 { error: "GH_NOT_CONFIGURED", message: "..." }
  → 400 { error: "PUSH_FAILED", message: "..." }
  → 400 { error: "PR_FAILED", message: "..." }
```

## Client Changes (Phase 2)

- `TicketDetail.tsx` — `Submit for Review` calls new endpoint instead of direct status update
- Show loading state with progress messages ("Committing changes…", "Creating PR…")
- On success, show PR link + status change
- On failure, show error inline (same pattern as per-button loading)

## Error Handling

All errors are user-facing. Show a toast/alert with the specific failure:

| Failure | Message |
|---------|---------|
| gh not installed | "GitHub CLI (gh) not found at {path}. Install from https://cli.github.com or update path in Settings." |
| No token configured | "Configure a GitHub token in Settings → GitHub to create PRs." |
| Token invalid / no repo scope | "GitHub authentication failed. Verify your token has `repo` scope." |
| git diff empty (nothing to commit) | Skip commit step, proceed to PR creation |
| git push rejected | "Push rejected. The remote branch may have diverged. Push manually and try again." |
| gh pr create fails | "Could not create PR: {stderr}. Verify your token has repo scope." |

**Atomicity**: If any step fails, the entire flow halts. Session NOT stopped, status NOT changed. User fixes and retries.

## Files to Touch (Phase 2)

| File | Change |
|------|--------|
| `src/shared/prompt-improver.ts` | Add `generateCommitMessage(diff)` using opencode SDK |
| `src/server/routes/ticket.ts` | Add `submitForReview` handler |
| `src/server/routes/gh.ts` | Add `POST /api/tickets/:id/submit-for-review` endpoint |
| `src/client/components/TicketDetail.tsx` | Update button to call new endpoint |
| `src/client/api/tickets.ts` | Add `submitForReview()` API call |
| `src/shared/rpc.ts` | Add `"submitForReview"` RPC entry |

---

## Dependencies

- `gh` CLI — user-installed system dependency (not npm). Detected at runtime.
- No new npm packages. gh found via `which gh` or configured path.

---

## Future: GitHub App Auth

If PAT management becomes friction:
- Register a GitHub App
- Use device flow to generate short-lived user access tokens
- Store refresh token, auto-renew
- More complex but supports org policies

Not needed for v1.
