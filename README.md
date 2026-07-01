# Pinboard

<p align="center">
  <img src="./public/OG-preview.png" alt="Pinboard logo" width="800">
</p>

**Pin your opencode work like a pro — without leaving your browser.**

> **Not affiliated with OpenCode.** This project is built by the community, not the OpenCode team. It is not officially endorsed by or associated with [opencode](https://github.com/anomalyco/opencode) or its maintainers.

Pinboard is a lightweight local dashboard that sits on top of [opencode](https://github.com/anomalyco/opencode). It turns your opencode sessions into tickets — giving you a bird's-eye view of everything you're working on, what you've done, and how much it cost.

## Why?

opencode is great at what it does — it's an AI coding agent that runs in your terminal. But once you have multiple projects going, it's easy to lose track:

- Which repos am I working on?
- What was I doing in that session yesterday?
- How much did that feature cost in API tokens?

Pinboard gives you a simple browser interface to answer all of that. Think of it like a lightweight Jira for your local AI coding sessions — but without the setup, the cloud, or the complexity.

## How it works

Pinboard runs entirely on your machine. Nothing leaves your computer.

1. **Add repos** — point Pinboard at any local Git repo, or clone from GitHub
2. **Create tickets** — give each ticket a title, description, priority, category, and repo. A feature branch is generated automatically (e.g. `feat/my-feature-uuid`).
3. **Start a session** — Pinboard creates a dedicated git worktree for the ticket, launches opencode in the background, and opens a split-panel view in your browser. Each session is fully isolated — work on multiple tickets in parallel.
4. **Code** — talk to opencode in the right panel while viewing ticket details on the left. Sessions resume where you left off, preserving the full conversation history.
5. **Track** — see active sessions, weekly costs, daily cost history, per-repo and per-model breakdowns. Cost data comes directly from opencode.
6. **Breeze through restarts** — active sessions survive server restarts. Pinboard picks up where it left off.

Switch between **Overview** (dashboard with stats, cost charts, activity timeline), **List** (filterable table), **Board** (drag-and-drop Kanban), and **Journal** (daily activity grouped by day). Each ticket tracks its session history, token usage, and cost automatically.

## Version control

Pinboard is deeply integrated with Git. Every ticket gets its own branch, a dedicated worktree, and automated tooling from creation to merge.

### Branch naming

Branches are generated automatically based on the ticket's category:

| Category    | Prefix    | Example                              |
|-------------|-----------|--------------------------------------|
| Feature     | `feat/`   | `feat/add-login-page`                |
| Bug         | `fix/`    | `fix/null-pointer`                   |
| Refactor    | `refactor/` | `refactor/api-layer`               |
| Chore       | `chore/`  | `chore/update-deps`                  |
| Docs        | `docs/`   | `docs/api-readme`                    |

No manual `git checkout -b` needed.

### Git worktrees

Every ticket runs in its own isolated worktree under `~/pinboard-worktrees/`:

- **Auto-created** when you start a session
- **Auto-cleaned** when the ticket is resolved or closed
- **Persist across restarts** — sessions pick up where they left off
- **Parallel-safe** — work on multiple tickets in the same repo at the same time

### Submit for review

Click **Submit for review** and Pinboard handles the whole pipeline: generates a commit message from your diff via opencode AI, commits and pushes your changes, creates a PR with the GitHub CLI, and moves the ticket to **Needs Review**.

### Resolve & merge

Drag a ticket to **Resolved** and Pinboard squashes all branch commits, merges them onto the base branch, and cleans up the worktree. No manual rebasing or merge conflicts to handle.

### GitHub CLI integration

Pinboard pairs with the [GitHub CLI](https://cli.github.com/) for auth and PR creation — auto-detects `gh`, supports OAuth device flow and personal access tokens (with encrypted storage), and can even auto-install it if missing. Configure everything in **Settings → Version Control**.

### Repository cloning

Add a repo from GitHub by pasting any Git URL — SSH, HTTPS, or HTTPS with a token. Pinboard clones it to `~/.pinboard/repos/` and detects the default branch automatically.

## Quick start

### Prerequisites

- [Bun](https://bun.sh) (JavaScript runtime)
- [opencode](https://github.com/anomalyco/opencode) (the AI coding agent)

### Install (one-liner)

```bash
curl -fsSL https://raw.githubusercontent.com/anas1412/opencode-pinboard/main/pinboard.sh | bash
```

Or use the compiled installer binary (from a [release](https://github.com/anas1412/opencode-pinboard/releases)):
```bash
# Linux
./pinboard-install-linux
# Windows
pinboard-install-windows.exe
```

### Run the desktop app

| Platform | How to launch |
|---|---|
| **Linux** | Find **Pinboard** in your app menu (installed to `~/.local/share/applications/pinboard.desktop`) |
| **Windows** | Run `Pinboard-dev.exe` from `build/dev-win32-x64/Pinboard-dev/` |

Or from the project directory:
```bash
bun run dev          # Dev mode with hot-reload, opens desktop window
```

### Build manually

```bash
git clone https://github.com/anas1412/opencode-pinboard.git
cd opencode-pinboard
bun install
bun run db:migrate
bun run build        # Produces the native desktop app in build/
```

### Update

```bash
git pull
bun install
bun run db:migrate
bun run build
```

### Uninstall

```bash
cd ..
rm -rf opencode-pinboard
rm -rf ~/.pinboard
rm -rf ~/pinboard-worktrees
```

### Add a repo

Click the **+** button in the sidebar under Repos. You have two options:

**Local folder** — pick any local Git repository. Pinboard detects the repo name and default branch automatically.

**Clone from GitHub** — paste a git URL (SSH or HTTPS). Pinboard clones it to `~/.pinboard/repos/` and adds it automatically.

> **Private repos**: If cloning fails with a permission error, make sure you have SSH keys set up:
> ```
> ssh -T git@github.com          # test your SSH connection
> ssh-add -l                      # list loaded keys
> ssh-add ~/.ssh/id_ed25519       # add your key to the agent
> ```
> Or use an HTTPS URL with a personal access token:
> ```
> https://<username>:<token>@github.com/user/repo.git
> ```
> Create a token at https://github.com/settings/tokens.

### Create a ticket

Click **New ticket**, give it a title, description, priority, category, and assign it to a repo. A branch is generated automatically, and the worktree is created on first session start.

### Start working

Click **Start session**. Pinboard creates a git worktree in `~/pinboard-worktrees/`, launches opencode for that ticket, and optionally refines your ticket description into a more structured prompt before sending it. The opencode session appears in an iframe in the right panel. Stop the session when done; resume it later — the conversation history is preserved.

### Batch operations

Select multiple tickets to update their status, priority, or category in bulk, or delete them in one go.

### Generate notes

After a session, click **Generate notes** to have opencode summarize the session transcript into bullet-point notes, saved directly on the ticket.

## Views

| View | Description |
|---|---|
| **Overview** | Dashboard with stat cards, daily usage chart (30 days), recent tickets, activity timeline, and per-repo cost breakdown |
| **List** | Filterable ticket table with search, status, priority, and category filters |
| **Board** | Drag-and-drop Kanban with columns: Open, In Progress, Needs Review, Changes Requested, Resolved |
| **Journal** | Paginated daily view grouping tickets by day, showing notes, changed files, branch, and repo name |
| **Usage** | Cost history with per-repo, per-ticket, and per-model breakdowns and date range filtering |
| **Settings** | Repo management (add/edit/remove), opencode config display, forward-description toggle, and theme picker (amber/emerald/violet/sky) |

## Commands

| Command | What it does |
|---|---|
| `bun run dev` | Start the server (serves both API and client, default port 3000) |
| `bun run build` | Build client + server for production |
| `bun run build:client` | Build only the frontend (Vite) |
| `bun run build:server` | Build only the server (Bun bundle) |
| `bun run build:installer` | Compile a single-file installer binary → `dist/pinboard-install` (or `.exe` on Windows) |
| `bun run db:migrate` | Apply database migrations |
| `bun run db:generate` | Generate migrations from schema |
| `bun run typecheck` | Type-check the codebase |
| `bun test` | Run tests |

### Compile a single binary

```bash
# Installer — bundles everything into one executable (Linux/macOS/Windows)
bun run build:installer

# The output binary auto-suffixed per platform:
#   Linux:   dist/pinboard-install
#   Windows: dist/pinboard-install.exe
```

The installer binary handles: checking prerequisites, installing bun/opencode if missing (Unix), cloning the repo, running migrations, and building the frontend. Run it with `--help` to see options.

## Tech stack

- **Desktop shell**: Electrobun (native desktop wrapper via OS webview, not Electron)
- **Frontend**: React 19, Tailwind CSS 4, Vite 6, Zustand 5, TanStack Query 5, TanStack Router 1, Lucide React, react-markdown + remark-gfm
- **Backend**: Fastify 5 (Bun runtime), Zod, chokidar
- **Database**: SQLite via Drizzle ORM
- **AI SDK**: @opencode-ai/sdk
- **IPC**: Electrobun RPC (frontend ↔ backend communication)

## License

MIT
