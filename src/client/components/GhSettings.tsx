import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchSettings, updateSettings } from "../api/settings";
import { request } from "../api/rpc-client";
import { GitBranch, Loader2, CheckCircle, XCircle, AlertTriangle, Download, Terminal, LogIn, ExternalLink } from "lucide-react";

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

// ─── OAuth Device Code Panel ────────────────────────────────────────────

function OAuthPanel({ onComplete, onCancel }: { onComplete: () => void; onCancel: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState("");
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Start device auth on mount
  useEffect(() => {
    request("ghAuthStart").then((res) => {
      setCode(res.userCode);
      setVerificationUri(res.verificationUri);
      setDeviceCode(res.deviceCode);
      setPolling(true);

      // Open browser to verification URL
      window.open(res.verificationUri, "_blank", "noopener,noreferrer");
    }).catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to start authentication");
    });

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Poll once deviceCode is set
  useEffect(() => {
    if (!deviceCode || !polling) return;

    pollRef.current = setInterval(async () => {
      try {
        const res = await request("ghAuthPoll", { deviceCode: deviceCode! });
        if (res.status === "success") {
          if (pollRef.current) clearInterval(pollRef.current);
          onComplete();
        } else if (res.status === "expired" || res.status === "error") {
          if (pollRef.current) clearInterval(pollRef.current);
          setError(res.error || "Authentication expired or denied");
          setPolling(false);
        }
        // "pending" — keep polling
      } catch {
        // keep polling
      }
    }, 5000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [deviceCode, polling, onComplete]);

  return (
    <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-5 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <Loader2 size={14} className="animate-spin text-[var(--accent)]" />
        <p className="text-sm font-medium text-white">Sign in to GitHub</p>
      </div>

      {code && (
        <>
          <p className="text-xs text-zinc-400 mb-3">
            Enter the following code on the GitHub page that opened in your browser:
          </p>

          <div className="bg-zinc-950 border border-zinc-700 rounded-lg px-6 py-4 mb-3 text-center">
            <span className="text-2xl font-bold text-white tracking-widest select-all font-mono">
              {code}
            </span>
          </div>

          <div className="flex items-center gap-2 mb-4">
            <a
              href={verificationUri}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-[var(--accent)] hover:underline"
            >
              <ExternalLink size={12} />
              {verificationUri}
            </a>
            <span className="text-xs text-zinc-600">(click if page didn't open)</span>
          </div>

          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <Loader2 size={10} className="animate-spin" />
            Waiting for you to authorize...
          </div>
        </>
      )}

      {error && (
        <div className="flex items-start gap-2 mt-2">
          <XCircle size={14} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-xs text-red-300">{error}</p>
        </div>
      )}

      <button
        onClick={onCancel}
        className="mt-4 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

// ─── GhSettings component ───────────────────────────────────────────────

export default function GhSettings() {
  const qc = useQueryClient();

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

  // ── gh connection state ─────────────────────────────────────────────
  const [ghState, setGhState] = useState<GhState>({ phase: "checking" });
  const [showingOAuth, setShowingOAuth] = useState(false);

  const { data: ghTestResult, isLoading: ghTesting, refetch: testGh } = useQuery({
    queryKey: ["gh-test"],
    queryFn: () => request("ghTest"),
    enabled: false,
    retry: false,
  });

  // Initial check on mount
  useEffect(() => {
    request("ghTest").then((res) => {
      if (res.ok && res.user) {
        setGhState({ phase: "authed", user: res.user });
      } else if (res.error && res.error.includes("not found")) {
        setGhState({ phase: "missing" });
      } else {
        setGhState({ phase: "no-token" });
      }
    }).catch(() => {
      setGhState({ phase: "checking" });
    });
  }, []);

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
          } else {
            setGhState({ phase: "no-token" });
          }
        });
      }
    },
  });

  // ── Handlers ────────────────────────────────────────────────────────
  const handleTest = async () => {
    if (formDirty) {
      await saveGhSettings.mutateAsync({ ghPath, defaultRemote });
    }
    const res = await testGh();
    if (res.data?.ok && res.data?.user) {
      setGhState({ phase: "authed", user: res.data.user });
    } else if (res.data?.error?.includes("not found")) {
      setGhState({ phase: "missing" });
    } else if (res.data?.error) {
      setGhState({ phase: "error", message: res.data.error });
    } else {
      setGhState({ phase: "no-token" });
    }
  };

  const handleDisconnect = () => {
    saveGhSettings.mutate({ ghToken: "" });
    setGhState({ phase: "no-token" });
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

  const handleOAuthComplete = async () => {
    setShowingOAuth(false);
    setGhState({ phase: "checking" });
    // Refresh to show profile
    qc.invalidateQueries({ queryKey: ["settings"] });
    const res = await request("ghTest");
    if (res.ok && res.user) {
      setGhState({ phase: "authed", user: res.user });
    } else {
      setGhState({ phase: "no-token" });
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

      {/* OAuth device flow panel */}
      {showingOAuth && (
        <OAuthPanel
          onComplete={handleOAuthComplete}
          onCancel={() => setShowingOAuth(false)}
        />
      )}

      {/* Error state */}
      {ghState.phase === "error" && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4 flex items-start gap-2">
          <XCircle size={14} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-xs text-red-300">{ghState.message}</p>
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
            <a
              href="https://github.com/settings/tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent)] hover:underline"
            >
              Create one
            </a>
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
          disabled={ghTesting || saveGhSettings.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors disabled:opacity-50"
        >
          {ghTesting ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Terminal size={12} />
          )}
          {ghTesting ? "Testing..." : ghState.phase === "authed" ? "Re-test Connection" : "Test Connection"}
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

        {ghState.phase !== "authed" && ghState.phase !== "missing" && ghState.phase !== "checking" && (
          <button
            onClick={() => setShowingOAuth(true)}
            disabled={showingOAuth}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors disabled:opacity-50 ml-auto"
          >
            <LogIn size={12} />
            Sign in with GitHub
          </button>
        )}

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
