import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchSettings, updateSettings } from "../api/settings";
import { request } from "../api/rpc-client";
import { useAppStore, type GhUser } from "../store/app";
import { GitBranch, Loader2, CheckCircle, XCircle, AlertTriangle, Download, Github, ExternalLink, Copy, LogIn, Terminal } from "lucide-react";

// ─── Gh status types ───────────────────────────────────────────────────

type GhState =
  | { phase: "checking" }
  | { phase: "missing" }
  | { phase: "no-token" }
  | { phase: "authed"; user: { login: string; name: string | null; email: string | null; avatarUrl: string | null; plan: string | null } }
  | { phase: "error"; message: string };

// ─── Section card (matches Settings.tsx pattern) ────────────────────────

function SectionCard({ icon, title, description, children }: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-zinc-800 rounded-lg p-5">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-zinc-400">{icon}</span>
        <h3 className="text-sm font-medium text-white">{title}</h3>
      </div>
      <p className="text-xs text-zinc-500 mb-4">{description}</p>
      {children}
    </div>
  );
}

// ─── Platform install guide ─────────────────────────────────────────────

function getPlatformInstallHint(): string {
  if (typeof navigator === "undefined") return "Install from https://cli.github.com";
  const ua = navigator.userAgent;
  if (ua.includes("Linux")) return "sudo apt install gh";
  if (ua.includes("Mac")) return "brew install gh";
  if (ua.includes("Windows")) return "winget install --id GitHub.cli";
  return "Install from https://cli.github.com";
}

// ─── GhSettings component ───────────────────────────────────────────────

export default function GhSettings() {
  const qc = useQueryClient();
  const { ghUser: cachedUser, ghPhase: cachedPhase, setGhAuth } = useAppStore();

  // ── Settings from server ────────────────────────────────────────────
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
  });

  // ── Local form state (token is write-only, never read back) ──────────
  const [ghPath, setGhPath] = useState("gh");
  const [ghToken, setGhToken] = useState("");
  const [defaultRemote, setDefaultRemote] = useState("origin");
  const [formDirty, setFormDirty] = useState(false);

  // Sync server settings → local
  useEffect(() => {
    if (settings) {
      setGhPath(settings.ghPath || "gh");
      setDefaultRemote(settings.defaultRemote || "origin");
    }
  }, [settings]);

  // ── gh connection state ──────────────────────────────────────────────
  const [ghState, setGhState] = useState<GhState>({ phase: "checking" });
  const [testing, setTesting] = useState(false);

  // Check auth on mount (also react to store updates from sidebar)
  useEffect(() => {
    if (cachedPhase === "authed" && cachedUser) {
      setGhState({ phase: "authed", user: cachedUser });
      return;
    }
    // No cached result yet — run our own check
    request("ghTest").then((res) => {
      if (res.ok && res.user) {
        setGhState({ phase: "authed", user: res.user });
        setGhAuth("authed", res.user as GhUser);
      } else if (res.error?.includes("not found")) {
        setGhState({ phase: "missing" });
        setGhAuth("missing");
      } else {
        setGhState({ phase: "no-token" });
        setGhAuth("no-token");
      }
    }).catch(() => {
      setGhState({ phase: "error", message: "Failed to check GitHub connection" });
    });
  }, []); // run once on mount

  // ── Mutations ───────────────────────────────────────────────────────
  const saveGhSettings = useMutation({
    mutationFn: (input: { ghPath?: string; ghToken?: string; defaultRemote?: string }) =>
      updateSettings(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      setFormDirty(false);
      setGhToken("");
    },
  });

  const installGh = useMutation({
    mutationFn: () => request("ghInstall"),
    onSuccess: (data) => {
      if (data.success) {
        setGhState({ phase: "checking" });
        request("ghTest").then((res) => {
          if (res.ok && res.user) {
            setGhState({ phase: "authed", user: res.user });
            setGhAuth("authed", res.user as GhUser);
          } else {
            setGhState({ phase: "no-token" });
            setGhAuth("no-token");
          }
        });
      }
    },
  });

  // ── Handlers ────────────────────────────────────────────────────────
  const handleTest = async () => {
    if (formDirty) {
      try { await saveGhSettings.mutateAsync({ ghPath, defaultRemote }); } catch { /* continue anyway */ }
    }
    setTesting(true);
    setGhState({ phase: "checking" });
    try {
      const res = await request("ghTest");
      if (res.ok && res.user) {
        setGhState({ phase: "authed", user: res.user });
        setGhAuth("authed", res.user as GhUser);
      } else if (res.error?.includes("not found")) {
        setGhState({ phase: "missing" });
        setGhAuth("missing");
      } else if (res.error) {
        setGhState({ phase: "error", message: res.error });
      } else {
        setGhState({ phase: "no-token" });
        setGhAuth("no-token");
      }
    } catch (err) {
      setGhState({ phase: "error", message: err instanceof Error ? err.message : "Connection test failed" });
    } finally {
      setTesting(false);
    }
  };

  const handleDisconnect = async () => {
    // Clear gh CLI credentials
    try { await request("ghLogout"); } catch { /* continue anyway */ }
    // Clear stored token
    saveGhSettings.mutate({ ghToken: "" });
    setGhState({ phase: "no-token" });
    setGhAuth("no-token");
  };

  const handleSave = () => {
    const input: { ghPath?: string; ghToken?: string; defaultRemote?: string } = { ghPath, defaultRemote };
    if (ghToken) input.ghToken = ghToken;
    saveGhSettings.mutate(input);
  };

  const handleInstall = () => {
    setGhState({ phase: "checking" });
    installGh.mutate();
  };

  // ── OAuth flow state ────────────────────────────────────────────────
  type OAuthPhase = "idle" | "starting" | "authorizing" | "error" | "expired";
  const [oauthPhase, setOauthPhase] = useState<OAuthPhase>("idle");
  const [oauthUserCode, setOauthUserCode] = useState("");
  const [oauthVerificationUri, setOauthVerificationUri] = useState("");
  const [oauthProcessId, setOauthProcessId] = useState("");
  const [oauthError, setOauthError] = useState("");
  const [oauthConfirming, setOauthConfirming] = useState(false);
  const oauthPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processIdRef = useRef("");
  const oauthActiveRef = useRef(false);

  // Keep processId in a ref so the poll function always has the latest value
  useEffect(() => { processIdRef.current = oauthProcessId; }, [oauthProcessId]);

  const cancelOAuth = useCallback(() => {
    oauthActiveRef.current = false;
    if (oauthPollRef.current) {
      clearTimeout(oauthPollRef.current);
      oauthPollRef.current = null;
    }
    setOauthPhase("idle");
    setOauthError("");
    setOauthConfirming(false);
  }, []);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      oauthActiveRef.current = false;
      if (oauthPollRef.current) clearTimeout(oauthPollRef.current);
    };
  }, []);

  const handleSignInWithGithub = async () => {
    setOauthPhase("starting");
    setOauthError("");

    try {
      const { processId, userCode, verificationUri } = await request("ghAuthLogin");
      setOauthProcessId(processId);
      processIdRef.current = processId;
      setOauthUserCode(userCode);
      setOauthVerificationUri(verificationUri);
      setOauthPhase("authorizing");

      // Auto-copy code to clipboard
      try { await navigator.clipboard.writeText(userCode); } catch { /* ignore */ }

      // Open GitHub device activation page
      request("openUrl", { url: "https://github.com/login/device" });

      // Mark flow as active
      oauthActiveRef.current = true;

      // Background polling (auto-detect if user authorizes)
      const poll = async () => {
        if (!oauthActiveRef.current) return;
        try {
          const pollRes = await request("ghAuthLoginPoll", { processId: processIdRef.current });
          if (!oauthActiveRef.current) return;

          if (pollRes.status === "success" && pollRes.user) {
            cancelOAuth();
            setGhState({ phase: "authed", user: pollRes.user });
            setGhAuth("authed", pollRes.user as GhUser);
            return;
          }

          if (pollRes.status === "expired") {
            cancelOAuth();
            setOauthPhase("expired");
            setOauthError(pollRes.error || "Session expired");
            return;
          }
        } catch { /* keep polling */ }

        if (oauthActiveRef.current) oauthPollRef.current = setTimeout(poll, 5000);
      };

      // Start background polling
      if (oauthPollRef.current) clearTimeout(oauthPollRef.current);
      oauthPollRef.current = setTimeout(poll, 3000);
    } catch (err) {
      setOauthPhase("error");
      setOauthError(err instanceof Error ? err.message : "Failed to start authorization");
    }
  };

  const handleConfirmAuthorized = async () => {
    setOauthConfirming(true);
    setOauthError("");
    try {
      const testRes = await request("ghTest");
      if (testRes.ok && testRes.user) {
        cancelOAuth();
        setGhState({ phase: "authed", user: testRes.user });
        setGhAuth("authed", testRes.user as GhUser);
        return;
      }
      if (processIdRef.current) {
        const pollRes = await request("ghAuthLoginPoll", { processId: processIdRef.current });
        if (pollRes.status === "success" && pollRes.user) {
          cancelOAuth();
          setGhState({ phase: "authed", user: pollRes.user });
          setGhAuth("authed", pollRes.user as GhUser);
          return;
        }
        if (pollRes.status === "pending") {
          setOauthError("Still waiting for GitHub response. Make sure you entered the code on github.com/login/device.");
        } else if (pollRes.status === "expired") {
          setOauthError("Session expired. Click Cancel and try again.");
        } else {
          setOauthError(pollRes.error || "Not yet authorized. Make sure you entered the code on GitHub.");
        }
      } else {
        setOauthError("Session not found. Click Cancel and try again.");
      }
      setOauthConfirming(false);
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : "Check failed");
      setOauthConfirming(false);
    }
  };

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(oauthUserCode);
    } catch {
      const el = document.getElementById("oauth-user-code");
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  };

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <SectionCard
      icon={<GitBranch size={14} />}
      title="GitHub"
      description="Connect your GitHub account to create PRs and manage repositories."
    >
      {/* gh not installed */}
      {ghState.phase === "missing" && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-4">
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="text-red-400 mt-0.5 shrink-0" />
            <div className="space-y-2">
              <p className="text-sm text-red-300 font-medium">gh CLI not found</p>
              <p className="text-xs text-zinc-400">
                Install GitHub CLI to enable PR creation and other GitHub features.
              </p>
              <div className="bg-zinc-900 rounded px-3 py-2 text-sm font-mono text-zinc-300">
                {getPlatformInstallHint()}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={handleInstall}
                  disabled={installGh.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors disabled:opacity-50"
                >
                  {installGh.isPending ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Download size={12} />
                  )}
                  {installGh.isPending ? "Installing..." : "Install gh automatically"}
                </button>
                <button
                  onClick={() => setGhState({ phase: "no-token" })}
                  className="px-3 py-1.5 rounded text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  I installed it manually
                </button>
              </div>
              {installGh.isError && (
                <p className="text-xs text-red-400">
                  Installation failed. Try manually: {getPlatformInstallHint()}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Checking state */}
      {ghState.phase === "checking" && (
        <div className="flex items-center gap-2 text-sm text-zinc-500 py-4">
          <Loader2 size={14} className="animate-spin" />
          Checking GitHub CLI...
        </div>
      )}

      {/* Profile card (authed) */}
      {ghState.phase === "authed" && (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 mb-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center overflow-hidden shrink-0">
              {ghState.user.avatarUrl ? (
                <img
                  src={ghState.user.avatarUrl}
                  alt=""
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                    (e.target as HTMLImageElement).parentElement!.textContent = ghState.user.login[0].toUpperCase();
                  }}
                />
              ) : (
                <span className="text-sm font-medium text-zinc-400">
                  {ghState.user.login[0].toUpperCase()}
                </span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">
                {ghState.user.name || ghState.user.login}
              </p>
              <p className="text-xs text-zinc-500 truncate">
                {ghState.user.email || ghState.user.login}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <CheckCircle size={14} className="text-emerald-400" />
              <span className="text-xs text-emerald-400 font-medium">Connected</span>
            </div>
          </div>
          {ghState.user.plan && (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <span className="bg-zinc-800 rounded px-2 py-0.5">{ghState.user.plan}</span>
            </div>
          )}
        </div>
      )}

      {/* Not connected — OAuth sign in flow */}
      {ghState.phase === "no-token" && oauthPhase === "idle" && (
        <div className="border border-zinc-800 rounded-lg p-4 mb-4 text-center">
          <Github size={32} className="mx-auto mb-3 text-zinc-400" />
          <p className="text-sm text-zinc-300 mb-1 font-medium">
            Connect your GitHub account
          </p>
          <p className="text-xs text-zinc-500 mb-4">
            Sign in to create PRs and manage repositories directly.
          </p>
          <button
            onClick={handleSignInWithGithub}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
          >
            <LogIn size={14} />
            Sign in with GitHub
          </button>
        </div>
      )}

      {/* OAuth flow: starting */}
      {ghState.phase === "no-token" && oauthPhase === "starting" && (
        <div className="border border-zinc-800 rounded-lg p-4 mb-4">
          <div className="flex items-center gap-3">
            <Loader2 size={16} className="animate-spin text-zinc-400" />
            <p className="text-sm text-zinc-300">Starting authorization...</p>
          </div>
        </div>
      )}

      {/* OAuth flow: showing code + waiting for user */}
      {ghState.phase === "no-token" && oauthPhase === "authorizing" && (
        <div className="border border-zinc-800 rounded-lg p-4 mb-4">
          <div className="mb-3">
            <p className="text-sm text-zinc-300 font-medium mb-1">Authorize GitHub access</p>
            <p className="text-xs text-zinc-500">
              Enter this code on the GitHub page that opened in your browser:
            </p>
          </div>

          {/* Code */}
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-3 mb-3 flex items-center justify-between">
            <code
              id="oauth-user-code"
              className="text-lg tracking-widest font-bold text-white select-all"
            >
              {oauthUserCode}
            </code>
            <button
              onClick={handleCopyCode}
              className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors bg-transparent border-none cursor-pointer"
              title="Copy code"
            >
              <Copy size={12} />
              Copy
            </button>
          </div>

          {/* Buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleConfirmAuthorized}
              disabled={oauthConfirming}
              className="flex items-center gap-1.5 px-4 py-2 rounded text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90 transition-colors disabled:opacity-50 cursor-pointer"
            >
              {oauthConfirming ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <CheckCircle size={12} />
              )}
              {oauthConfirming ? "Checking..." : "I've authorized — Confirm"}
            </button>
            <button
              onClick={() => request("openUrl", { url: "https://github.com/login/device" })}
              className="flex items-center gap-1.5 px-3 py-2 rounded text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors cursor-pointer"
            >
              <ExternalLink size={12} />
              Open GitHub
            </button>
            <button
              onClick={cancelOAuth}
              className="ml-auto px-3 py-2 rounded text-xs text-zinc-500 hover:text-zinc-300 transition-colors bg-transparent border border-zinc-800 hover:border-zinc-700 cursor-pointer"
            >
              Cancel
            </button>
          </div>

          {oauthError && (
            <p className="text-xs text-amber-400 mt-2">{oauthError}</p>
          )}
        </div>
      )}

      {/* OAuth flow: expired */}
      {ghState.phase === "no-token" && oauthPhase === "expired" && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-4 flex items-start gap-2">
          <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-amber-300">{oauthError || "Session expired"}</p>
            <button
              onClick={() => setOauthPhase("idle")}
              className="mt-1 text-xs text-[var(--accent)] hover:underline bg-transparent border-none p-0 cursor-pointer"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {/* OAuth flow: error */}
      {ghState.phase === "no-token" && oauthPhase === "error" && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4 flex items-start gap-2">
          <XCircle size={14} className="text-red-400 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-red-300">{oauthError || "Authorization failed"}</p>
            <button
              onClick={() => setOauthPhase("idle")}
              className="mt-1 text-xs text-[var(--accent)] hover:underline bg-transparent border-none p-0 cursor-pointer"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {/* Error state */}
      {ghState.phase === "error" && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4 flex items-start gap-2">
          <XCircle size={14} className="text-red-400 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-red-300">{ghState.message}</p>
            {ghState.message?.includes("gh auth login") && (
              <p className="text-xs text-zinc-500 mt-1">
                Click "Sign in with GitHub" above, or paste a Personal Access Token below.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Token + path form */}
      <div className="space-y-3">
        {/* gh CLI Path */}
        <div>
          <label className="block text-xs text-zinc-500 mb-1">gh CLI Path</label>
          <div className="flex items-center gap-2">
            <input
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600 font-mono"
              placeholder="gh"
              value={ghPath}
              onChange={(e) => { setGhPath(e.target.value); setFormDirty(true); }}
            />
            {ghState.phase === "authed" && (
              <CheckCircle size={14} className="text-emerald-400 shrink-0" />
            )}
          </div>
        </div>

        {/* Token input */}
        <div>
          <label className="block text-xs text-zinc-500 mb-1">
            Personal Access Token
            {ghState.phase === "authed" && (
              <span className="text-emerald-400 ml-2">(already set — leave blank to keep)</span>
            )}
          </label>
          <input
            type="password"
            className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600 font-mono"
            placeholder={ghState.phase === "authed" ? "••••••••••••••••" : "ghp_..."}
            value={ghToken}
            onChange={(e) => { setGhToken(e.target.value); setFormDirty(true); }}
          />
          <p className="text-xs text-zinc-600 mt-1">
            Optional if you've already run <code className="text-zinc-500">gh auth login</code>.{" "}
            Otherwise, requires <code className="text-zinc-500">repo</code> scope.{" "}
            <button
              onClick={() => request("openUrl", { url: "https://github.com/settings/tokens" })}
              className="text-[var(--accent)] hover:underline inline bg-transparent border-none p-0 text-xs cursor-pointer"
            >
              Create one
            </button>
          </p>
        </div>

        {/* Default remote */}
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Default Remote</label>
          <input
            className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600 font-mono"
            placeholder="origin"
            value={defaultRemote}
            onChange={(e) => { setDefaultRemote(e.target.value); setFormDirty(true); }}
          />
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2 mt-4">
        <button
          onClick={handleTest}
          disabled={testing || saveGhSettings.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors disabled:opacity-50"
        >
          {testing ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Terminal size={12} />
          )}
          {testing ? "Testing..." : ghState.phase === "authed" ? "Re-test Connection" : "Test Connection"}
        </button>

        <button
          onClick={handleSave}
          disabled={saveGhSettings.isPending || !formDirty}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90 transition-colors disabled:opacity-50"
        >
          {saveGhSettings.isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <CheckCircle size={12} />
          )}
          {saveGhSettings.isPending ? "Saving..." : "Save"}
        </button>

        {ghState.phase === "authed" && (
          <button
            onClick={handleDisconnect}
            disabled={saveGhSettings.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50 ml-auto"
          >
            <XCircle size={12} />
            Disconnect
          </button>
        )}
      </div>

      {saveGhSettings.isError && (
        <p className="text-xs text-red-400 mt-2">
          {saveGhSettings.error instanceof Error
            ? saveGhSettings.error.message
            : "Failed to save settings"}
        </p>
      )}
    </SectionCard>
  );
}
