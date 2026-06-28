#!/usr/bin/env bash
# Unix-only: Windows users, use opentack.bat or the opentack-install binary.
set -euo pipefail

REPO="anas1412/opentack"
BRANCH="main"
INSTALL_DIR="${OPENTACK_DIR:-$HOME/opentack}"
DATA_DIR="${OPENTACK_DATA_DIR:-$HOME/.opentack}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[info]${NC} $1"; }
ok()    { echo -e "${GREEN}[ok]${NC}   $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC} $1"; }
err()   { echo -e "${RED}[err]${NC}  $1"; }

# ── Silent dependency installers ───────────────────────────────────

ensure_deps() {
  # git is required and can't be auto-installed — check first
  if ! command -v git &>/dev/null; then
    err "git is required. Install it and re-run."
    exit 1
  fi
  ok "git $(git --version 2>/dev/null | head -1)"

  # ── Bun ──────────────────────────────────────────────────────────
  if ! command -v bun &>/dev/null; then
    info "Installing bun..."
    curl -fsSL https://bun.sh/install | bash
    # Source the env additions so bun is available in this session
    if [ -f "$HOME/.bashrc" ]; then
      # shellcheck source=/dev/null
      . "$HOME/.bashrc" 2>/dev/null || true
    fi
    # Fallback: explicitly add to PATH
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export PATH="$BUN_INSTALL/bin:$PATH"
    if ! command -v bun &>/dev/null; then
      err "bun installation failed. Check $HOME/.bun"
      exit 1
    fi
  fi
  ok "bun $(bun --version)"

  # ── Opencode ─────────────────────────────────────────────────────
  if ! command -v opencode &>/dev/null; then
    info "Installing opencode..."
    curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path
    export OPCODE_INSTALL="$HOME/.opencode"
    export PATH="$OPCODE_INSTALL/bin:$PATH"
    if ! command -v opencode &>/dev/null; then
      err "opencode installation failed. Check $HOME/.opencode/bin"
      exit 1
    fi
  fi
  ok "opencode $(opencode --version 2>/dev/null || echo 'found')"
}

# ── GStreamer (Linux only — WebKit media backend) ──────────────────

ensure_gstreamer() {
  # Only relevant on Linux — WebKitGTK hardcodes enable_media=TRUE
  # https://github.com/electrobun/electrobun (linux native wrapper)
  [ "$(uname -s)" != "Linux" ] && return 0

  # If gst-inspect-1.0 isn't available, GStreamer core isn't installed
  # and WebKit simply won't use it (no error).
  command -v gst-inspect-1.0 &>/dev/null || return 0

  # Check if the autoaudiosink element is available
  if gst-inspect-1.0 autoaudiosink &>/dev/null; then
    ok "GStreamer autoaudiosink found"
    return 0
  fi

  warn "GStreamer autoaudiosink not found — WebKit audio will produce warnings"

  # Detect package manager and install the plugin package
  local PKG_MGR PKG_NAME
  if   command -v apt-get &>/dev/null; then PKG_MGR="apt-get"; PKG_NAME="gstreamer1.0-plugins-base"
  elif command -v pacman  &>/dev/null; then PKG_MGR="pacman";  PKG_NAME="gst-plugins-base"
  elif command -v dnf     &>/dev/null; then PKG_MGR="dnf";     PKG_NAME="gstreamer1-plugins-base"
  elif command -v yum     &>/dev/null; then PKG_MGR="yum";     PKG_NAME="gstreamer1-plugins-base"
  elif command -v zypper  &>/dev/null; then PKG_MGR="zypper";  PKG_NAME="gstreamer-plugins-base"
  else
    warn "Could not detect package manager."
    warn "Install 'gst-plugins-base' manually, or ignore — the error is cosmetic."
    return 0
  fi

  info "Installing $PKG_NAME via $PKG_MGR (may require sudo)..."
  case "$PKG_MGR" in
    apt-get) sudo apt-get install -y "$PKG_NAME" ;;
    pacman)  sudo pacman -S --noconfirm "$PKG_NAME" ;;
    dnf|yum) sudo "$PKG_MGR" install -y "$PKG_NAME" ;;
    zypper)  sudo zypper --non-interactive install "$PKG_NAME" ;;
  esac

  if gst-inspect-1.0 autoaudiosink &>/dev/null; then
    ok "GStreamer autoaudiosink installed"
  else
    warn "Installation may have failed — check manually or ignore (cosmetic only)"
  fi
}

# ── Install ────────────────────────────────────────────────────────

cmd_install() {
  echo ""
  echo "  ╔══════════════════════════════════════════╗"
  echo "  ║         OpenTrack — Install              ║"
  echo "  ╚══════════════════════════════════════════╝"
  echo ""

  ensure_deps
  ensure_gstreamer

  if [ -d "$INSTALL_DIR" ]; then
    warn "$INSTALL_DIR already exists."
    echo "  To update instead, run: $0 update"
    echo "  To reinstall, remove it first: rm -rf $INSTALL_DIR"
    exit 1
  fi

  info "Cloning OpenTrack..."
  git clone --depth=1 --branch "$BRANCH" "https://github.com/$REPO.git" "$INSTALL_DIR"
  ok "Cloned to $INSTALL_DIR"

  cd "$INSTALL_DIR"

  info "Installing dependencies..."
  bun install
  ok "Dependencies installed"

  info "Running database migrations..."
  mkdir -p "$DATA_DIR"
  bun run db:migrate
  ok "Database ready"

  info "Setting default opencode theme..."
  TUI_DIR="$HOME/.config/opencode"
  mkdir -p "$TUI_DIR"
  cat > "$TUI_DIR/tui.json" <<- EOF
{
  "\$schema": "https://opencode.ai/tui.json",
  "theme": "opencode"
}
EOF
  ok "Default opencode theme set to 'opencode'"

  info "Building frontend..."
  bun run build
  ok "Build complete"

  echo ""
  echo "  ╔══════════════════════════════════════════╗"
  echo "  ║         OpenTrack is installed!          ║"
  echo "  ╚══════════════════════════════════════════╝"
  echo ""
  echo "  Run it:"
  echo "    cd $INSTALL_DIR && bun run dev"
  echo ""
  echo "  Then open http://localhost:3000 in your browser."
  echo ""
}

# ── Update ─────────────────────────────────────────────────────────

cmd_update() {
  echo ""
  echo "  ╔══════════════════════════════════════════╗"
  echo "  ║         OpenTrack — Update               ║"
  echo "  ╚══════════════════════════════════════════╝"
  echo ""

  if [ ! -d "$INSTALL_DIR/.git" ]; then
    err "No OpenTrack installation found at $INSTALL_DIR."
    echo "  Install it first: curl -fsSL https://raw.githubusercontent.com/$REPO/$BRANCH/opentack.sh | bash"
    exit 1
  fi

  cd "$INSTALL_DIR"

  info "Pulling latest changes..."
  git pull
  ok "Up to date"

  ensure_gstreamer

  info "Updating dependencies..."
  bun install
  ok "Dependencies updated"

  info "Running database migrations..."
  bun run db:migrate
  ok "Database up to date"

  info "Ensuring default opencode theme..."
  TUI_DIR="$HOME/.config/opencode"
  mkdir -p "$TUI_DIR"
  if [ ! -f "$TUI_DIR/tui.json" ]; then
    cat > "$TUI_DIR/tui.json" <<- EOF
{
  "\$schema": "https://opencode.ai/tui.json",
  "theme": "opencode"
}
EOF
    ok "Default opencode theme set to 'opencode'"
  else
    ok "OpenCode theme config already exists (skipped)"
  fi

  info "Rebuilding frontend..."
  bun run build
  ok "Rebuild complete"

  echo ""
  echo "  OpenTrack is up to date!"  
  echo ""
}

# ── Uninstall ──────────────────────────────────────────────────────

cmd_uninstall() {
  echo ""
  echo "  ╔══════════════════════════════════════════╗"
  echo "  ║         OpenTrack — Uninstall            ║"
  echo "  ╚══════════════════════════════════════════╝"
  echo ""

  if [ -d "$INSTALL_DIR" ]; then
    info "Removing $INSTALL_DIR..."
    rm -rf "$INSTALL_DIR"
    ok "Application removed"
  else
    warn "No installation found at $INSTALL_DIR"
  fi

  if [ -d "$DATA_DIR" ]; then
    info "Removing data directory $DATA_DIR..."
    rm -rf "$DATA_DIR"
    ok "Data removed"
  else
    warn "No data directory found at $DATA_DIR"
  fi

  echo ""
  ok "OpenTrack has been uninstalled."
  echo "  bun and opencode were kept — remove them manually if desired."
  echo ""
}

# ── Help ───────────────────────────────────────────────────────────

cmd_help() {
  echo "OpenTrack — local ticket-based workspace for opencode"
  echo ""
  echo "Usage: $0 <command>"
  echo ""
  echo "Commands:"
  echo "  install     Install OpenTrack and its dependencies"
  echo "  update      Pull latest version and rebuild"
  echo "  uninstall   Remove OpenTrack (keeps bun and opencode)"
  echo ""
}

# ── Main ───────────────────────────────────────────────────────────

case "${1:-install}" in
  install)   cmd_install ;;
  update)    cmd_update ;;
  uninstall) cmd_uninstall ;;
  help|--help|-h) cmd_help ;;
  *) err "Unknown command: $1"; echo ""; cmd_help; exit 1 ;;
esac
