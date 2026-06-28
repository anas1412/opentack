#!/usr/bin/env bun
/**
 * OpenTack Installer — single binary executable.
 *
 * Build:
 *   bun build --compile --target=bun --outfile=dist/opentack-install ./src/installer/index.ts
 *
 * What it does:
 *   1. Checks for git (must be pre-installed)
 *   2. Installs bun silently if missing
 *   3. Installs opencode silently if missing
 *   4. Installs GStreamer plugins (Linux only — WebKit media backend)
 *   5. Clones the OpenTack repo
 *   6. Runs bun install, DB migrations, and frontend build
 */

import { $ } from "bun"
import { homedir } from "os"
import { mkdirSync } from "fs"
import path from "path"

// ── Config ────────────────────────────────────────────────────────

const PKG_VERSION = "0.1.0"
const REPO = "anas1412/opentack"
const BRANCH = "main"
const HOME = homedir()
const INSTALL_DIR = Bun.env.OPENTACK_DIR || path.join(HOME, "opentack")
const DATA_DIR = Bun.env.OPENTACK_DATA_DIR || path.join(HOME, ".opentack")
const BUN_INSTALL_DIR = path.join(HOME, ".bun")
const OPENCODE_INSTALL_DIR = path.join(HOME, ".opencode")

// ── Pretty printing ───────────────────────────────────────────────

const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"
const BOLD = "\x1b[1m"
const NC = "\x1b[0m"

function info(msg: string)  { console.log(`${CYAN}[info]${NC}  ${msg}`) }
function ok(msg: string)    { console.log(`${GREEN}[ok]${NC}    ${msg}`) }
function warn(msg: string)  { console.log(`${YELLOW}[warn]${NC}  ${msg}`) }
function err(msg: string)   { console.log(`${RED}[err]${NC}   ${msg}`) }

function banner(title: string) {
  console.log()
  console.log(`  ${BOLD}╔══════════════════════════════════════════╗${NC}`)
  console.log(`  ${BOLD}║${NC}         ${title}${" ".repeat(Math.max(1, 37 - title.length))}${BOLD}║${NC}`)
  console.log(`  ${BOLD}╚══════════════════════════════════════════╝${NC}`)
  console.log()
}

// ── Helpers ───────────────────────────────────────────────────────

async function commandExists(cmd: string): Promise<boolean> {
  const which = process.platform === "win32" ? "where" : "which"
  try {
    const result = await $`${which} ${cmd}`.quiet()
    return result.exitCode === 0
  } catch {
    return false
  }
}

function prependPath(dir: string) {
  const current = process.env.PATH || ""
  const sep = process.platform === "win32" ? ";" : ":"
  if (!current.includes(dir)) {
    process.env.PATH = `${dir}${sep}${current}`
  }
}

async function curlPipe(url: string): Promise<void> {
  if (process.platform === "win32") {
    throw new Error("curl | bash is not supported on Windows. Install the tool manually.")
  }
  const proc = Bun.spawn(["bash"], {
    stdin: (await fetch(url)).body!,
    stdout: "inherit",
    stderr: "inherit",
  })
  const exit = await proc.exited
  if (exit !== 0) throw new Error(`Command exited with code ${exit}`)
}

// ── Steps ─────────────────────────────────────────────────────────

async function ensureGit(): Promise<void> {
  if (!await commandExists("git")) {
    err("git is required but not found.")
    console.log("  Install it with your package manager, then re-run this installer.")
    process.exit(1)
  }
  const v = await $`git --version`.text()
  ok(`git ${v.trim().split(" ").pop()}`)
}

async function ensureBun(): Promise<void> {
  if (await commandExists("bun")) {
    const v = (await $`bun --version`.text()).trim()
    ok(`bun ${v}`)
    return
  }

  if (process.platform === "win32") {
    warn("bun not found. Install it from https://bun.sh or: npm i -g bun")
    warn("Then re-run this installer.")
    process.exit(1)
  }

  info("Installing bun...")
  const res = await fetch("https://bun.sh/install")
  if (!res.ok) throw new Error(`Failed to fetch bun install script (${res.status})`)
  const script = await res.text()

  const proc = Bun.spawn(["bash"], {
    stdin: new Blob([script]).stream(),
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  })
  const exit = await proc.exited
  if (exit !== 0) throw new Error("bun installation script failed")

  prependPath(path.join(BUN_INSTALL_DIR, "bin"))
  if (!await commandExists("bun")) {
    err("bun binary not found after installation")
    process.exit(1)
  }
  ok(`bun ${(await $`bun --version`.text()).trim()}`)
}

async function ensureOpencode(): Promise<void> {
  if (await commandExists("opencode")) {
    const v = (await $`opencode --version`.text()).trim()
    ok(`opencode ${v}`)
    return
  }

  if (process.platform === "win32") {
    warn("opencode not found. Install it from https://opencode.ai/download")
    warn("Then re-run this installer.")
    process.exit(1)
  }

  info("Installing opencode...")
  const res = await fetch("https://opencode.ai/install")
  if (!res.ok) throw new Error(`Failed to fetch opencode install script (${res.status})`)
  const script = await res.text()

  const proc = Bun.spawn(["bash", "-s", "--", "--no-modify-path"], {
    stdin: new Blob([script]).stream(),
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  })
  const exit = await proc.exited
  if (exit !== 0) throw new Error("opencode installation script failed")

  prependPath(path.join(OPENCODE_INSTALL_DIR, "bin"))
  if (!await commandExists("opencode")) {
    err("opencode binary not found after installation")
    process.exit(1)
  }
  ok(`opencode ${(await $`opencode --version`.text()).trim()}`)
}

async function ensureGStreamer(): Promise<void> {
  // GStreamer is only needed on Linux (WebKitGTK hardcodes enable_media=TRUE)
  if (process.platform !== "linux") return

  const hasGstInspect = await commandExists("gst-inspect-1.0")
  if (!hasGstInspect) return // No GStreamer core installed — WebKit won't try

  // Check if the autoaudiosink plugin element is available
  try {
    await $`gst-inspect-1.0 autoaudiosink`.quiet()
    ok("GStreamer autoaudiosink found")
    return
  } catch {
    warn("GStreamer autoaudiosink not found — WebKit audio will produce warnings")
  }

  // Detect package manager and install GStreamer plugin packages
  // autoaudiosink needs gst-plugins-good on Arch (pulsesink),
  // gst-plugins-bad on Debian/Ubuntu. Install both to be safe.
  interface PkgInfo { manager: string; pkgs: string[] }
  let pkg: PkgInfo | null = null

  if (await commandExists("apt-get"))   pkg = { manager: "apt-get", pkgs: ["gstreamer1.0-plugins-base", "gstreamer1.0-plugins-bad"] }
  else if (await commandExists("pacman")) pkg = { manager: "pacman",  pkgs: ["gst-plugins-base", "gst-plugins-bad", "gst-plugins-good"] }
  else if (await commandExists("dnf"))    pkg = { manager: "dnf",     pkgs: ["gstreamer1-plugins-base", "gstreamer1-plugins-bad"] }
  else if (await commandExists("yum"))    pkg = { manager: "yum",     pkgs: ["gstreamer1-plugins-base", "gstreamer1-plugins-bad"] }
  else if (await commandExists("zypper")) pkg = { manager: "zypper",  pkgs: ["gstreamer-plugins-base", "gstreamer-plugins-bad"] }

  if (!pkg) {
    warn("Could not detect package manager. Install 'gst-plugins-good' manually.")
    warn("Or ignore — the error is cosmetic (the app will still work).")
    return
  }

  info(`Installing GStreamer plugins via ${pkg.manager} (may require sudo)...`)

  const installCmd: Record<string, string[]> = {
    "apt-get": ["apt-get", "install", "-y", ...pkg.pkgs],
    "pacman":  ["pacman", "-S", "--noconfirm", ...pkg.pkgs],
    "dnf":     ["dnf", "install", "-y", ...pkg.pkgs],
    "yum":     ["yum", "install", "-y", ...pkg.pkgs],
    "zypper":  ["zypper", "--non-interactive", "install", ...pkg.pkgs],
  }

  const proc = Bun.spawn(["sudo", ...installCmd[pkg.manager]], {
    stdio: ["inherit", "inherit", "inherit"],
  })
  const exit = await proc.exited

  if (exit !== 0) {
    warn(`sudo ${pkg.manager} exited with code ${exit}`)
    warn("Install gst-plugins-good manually, or ignore — it's cosmetic.")
    return
  }

  // Verify installation
  try {
    await $`gst-inspect-1.0 autoaudiosink`.quiet()
    ok("GStreamer autoaudiosink found")
  } catch {
    warn("Installation may have failed — check manually")
  }
}

async function installOpenTack(): Promise<void> {
  const dir = INSTALL_DIR

  if (await Bun.file(path.join(dir, ".git")).exists()) {
    warn(`${dir} already exists and is a git repository.`)
    console.log("  To update, run: opentack-update")
    const rmCmd = process.platform === "win32" ? "rmdir /s" : "rm -rf"
    console.log(`  To reinstall, remove it first: ${rmCmd} ${dir}`)
    return
  }

  // If directory exists but isn't a git repo, bail
  if (await Bun.file(dir).exists()) {
    err(`${dir} exists but is not a git repository.`)
    const rmCmd = process.platform === "win32" ? "rmdir /s" : "rm -rf"
    console.log(`  Remove it: ${rmCmd} ${dir}`)
    console.log("  Then re-run this installer.")
    process.exit(1)
  }

  info("Cloning OpenTack...")
  await $`git clone --depth=1 --branch ${BRANCH} https://github.com/${REPO}.git ${dir}`
  ok(`Cloned to ${dir}`)

  // Run setup
  await $`bun install`.cwd(dir)
  ok("Dependencies installed")

  mkdirSync(DATA_DIR, { recursive: true })
  // Run DB migrations via the installed bun binary
  await $`bun run db:migrate`.cwd(dir)
  ok("Database ready")

  // Set default opencode theme
  const tuiDir = path.join(HOME, ".config", "opencode")
  mkdirSync(tuiDir, { recursive: true })
  const tuiFile = `${tuiDir}/tui.json`
  if (!await Bun.file(tuiFile).exists()) {
    await Bun.write(
      tuiFile,
      JSON.stringify({ $schema: "https://opencode.ai/tui.json", theme: "opencode" }, null, 2),
    )
    ok("Default opencode theme set to 'opencode'")
  }

  // Build frontend
  await $`bun run build`.cwd(dir)
  ok("Build complete")
}

// ── Main ──────────────────────────────────────────────────────────

function printHelp() {
  console.log(`OpenTack Installer v${PKG_VERSION}`)
  console.log(`Single-binary installer for ${REPO}`)
  console.log()
  console.log("Usage: opentack-install [options]")
  console.log()
  console.log("Options:")
  console.log("  --help, -h     Show this help")
  console.log("  --version, -v  Show version")
  console.log()
  console.log("Environment variables:")
  console.log("  OPENTACK_DIR       Install directory (default: ~/opentack)")
  console.log("  OPENTACK_DATA_DIR  Data directory  (default: ~/.opentack)")
  console.log()
  console.log("What it does:")
console.log("  1. Checks for git (must be pre-installed)")
console.log("  2. Installs bun silently if missing")
console.log("  3. Installs opencode silently if missing")
console.log("  4. Installs GStreamer plugins (Linux only — WebKit media)")
console.log("  5. Clones the OpenTack repo")
console.log("  6. Runs bun install, DB migrations, and frontend build")
  console.log()
}

async function main() {
  const args = process.argv.slice(2)

  if (args.includes("--help") || args.includes("-h")) {
    printHelp()
    return
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(PKG_VERSION)
    return
  }

  banner("OpenTack — Install")

  await ensureGit()
  await ensureBun()
  await ensureOpencode()
  await ensureGStreamer()
  await installOpenTack()

  banner("OpenTack is installed!")
  console.log(`  ${BOLD}Run it:${NC}`)
  console.log(`    cd ${INSTALL_DIR} && bun run dev`)
  console.log()
  console.log(`  ${BOLD}Data directory:${NC} ${DATA_DIR}`)
  console.log()
}

main().catch((e) => {
  err(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
