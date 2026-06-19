import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRepos, useUpdateRepo } from "../hooks/useRepos";
import { fetchSettings, updateSettings } from "../api/settings";
import { fetchOpencodeConfig, updateOpencodeConfig, fetchAgents } from "../api/opencode-config";
import { THEMES, type Theme } from "../../shared/types";
import { useAppStore } from "../store/app";
import { Settings2, Plus, X, Save, Send, Palette, Cpu, Bot } from "lucide-react";

// ─── Env var editor (unchanged from original) ──────────────────────────

interface EnvEntry {
  key: string;
  value: string;
}

function RepoSettingsCard({ repo }: { repo: { id: string; name: string; envVars: Record<string, string> } }) {
  const updateRepo = useUpdateRepo();
  const [entries, setEntries] = useState<EnvEntry[]>(() => Object.entries(repo.envVars).map(([k, v]) => ({ key: k, value: v })));
  const [dirty, setDirty] = useState(false);

  const updateEntry = (i: number, field: "key" | "value", val: string) => {
    setEntries((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], [field]: val };
      return next;
    });
    setDirty(true);
  };

  const addEntry = () => {
    setEntries((prev) => [...prev, { key: "", value: "" }]);
    setDirty(true);
  };

  const removeEntry = (i: number) => {
    setEntries((prev) => prev.filter((_, idx) => idx !== i));
    setDirty(true);
  };

  const handleSave = () => {
    const envVars: Record<string, string> = {};
    for (const { key, value } of entries) {
      if (key.trim()) envVars[key.trim()] = value;
    }
    updateRepo.mutate({ id: repo.id, input: { envVars } });
    setDirty(false);
  };

  return (
    <div className="border border-zinc-800 rounded-lg p-4">
      <h3 className="text-sm font-medium text-white mb-3">{repo.name}</h3>

      {entries.length === 0 && (
        <p className="text-xs text-zinc-600 italic mb-3">No environment variables configured</p>
      )}

      <div className="space-y-2 mb-3">
        {entries.map((entry, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600 font-mono"
              placeholder="KEY"
              value={entry.key}
              onChange={(e) => updateEntry(i, "key", e.target.value)}
            />
            <input
              className="flex-[2] bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600 font-mono"
              placeholder="value"
              value={entry.value}
              onChange={(e) => updateEntry(i, "value", e.target.value)}
            />
            <button
              onClick={() => removeEntry(i)}
              className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={addEntry}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
        >
          <Plus size={12} />
          Add variable
        </button>
        {dirty && (
          <button
            onClick={handleSave}
            disabled={updateRepo.isPending}
            className="btn-primary !text-xs"
          >
            <Save size={12} />
            {updateRepo.isPending ? "Saving..." : "Save"}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Theme color swatch picker ───────────────────────────────────────

const THEME_COLORS: Record<Theme, { bg: string; ring: string; label: string }> = {
  amber: { bg: "bg-amber-500", ring: "ring-amber-400", label: "Amber" },
  emerald: { bg: "bg-emerald-500", ring: "ring-emerald-400", label: "Emerald" },
  violet: { bg: "bg-violet-500", ring: "ring-violet-400", label: "Violet" },
  sky: { bg: "bg-sky-500", ring: "ring-sky-400", label: "Sky" },
};

function ThemePicker({ value, onChange }: { value: Theme; onChange: (t: Theme) => void }) {
  return (
    <div className="flex gap-3">
      {THEMES.map((theme) => {
        const colors = THEME_COLORS[theme];
        return (
          <button
            key={theme}
            onClick={() => onChange(theme)}
            className={`w-10 h-10 rounded-full ${colors.bg} transition-all duration-150 ${
              value === theme
                ? `ring-2 ${colors.ring} ring-offset-2 ring-offset-zinc-950 scale-110`
                : "ring-1 ring-zinc-700 hover:ring-zinc-500"
            }`}
            title={colors.label}
          />
        );
      })}
    </div>
  );
}

// ─── Section card wrapper ────────────────────────────────────────────

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

// ─── Main Settings page ──────────────────────────────────────────────

export default function Settings() {
  const qc = useQueryClient();
  const { data: repos, isLoading: reposLoading } = useRepos();
  const setTheme = useAppStore((s) => s.setTheme);

  // ── Load settings ──────────────────────────────────────────────────
  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
  });

  const { data: opencodeCfg, isLoading: cfgLoading } = useQuery({
    queryKey: ["opencode-config"],
    queryFn: fetchOpencodeConfig,
  });

  const { data: agents = [] } = useQuery({
    queryKey: ["opencode-agents"],
    queryFn: fetchAgents,
  });

  // ── Local state ────────────────────────────────────────────────────
  const [forward, setForward] = useState(true);
  const [theme, setLocalTheme] = useState<Theme>("amber");
  const [model, setModel] = useState("");
  const [modelDirty, setModelDirty] = useState(false);
  const [defaultAgent, setDefaultAgent] = useState("");
  const [agentDirty, setAgentDirty] = useState(false);

  // Sync server state → local on load
  useEffect(() => {
    if (settings) {
      setForward(settings.forwardDescription);
      setLocalTheme(settings.theme);
    }
  }, [settings]);

  useEffect(() => {
    if (opencodeCfg) {
      setModel(opencodeCfg.model || "");
      setDefaultAgent(opencodeCfg.default_agent || "build");
    }
  }, [opencodeCfg]);

  // ── Mutations ──────────────────────────────────────────────────────
  const saveSettings = useMutation({
    mutationFn: (input: { forwardDescription: boolean; theme: Theme }) => updateSettings(input),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      setTheme(data.theme);
    },
  });

  const saveModel = useMutation({
    mutationFn: (input: { model: string }) => updateOpencodeConfig(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["opencode-config"] });
      setModelDirty(false);
    },
  });

  const saveAgent = useMutation({
    mutationFn: (input: { default_agent: string }) => updateOpencodeConfig(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["opencode-config"] });
      setAgentDirty(false);
    },
  });

  // ── Handlers ───────────────────────────────────────────────────────
  const handleToggleForward = () => {
    const next = !forward;
    setForward(next);
    saveSettings.mutate({ forwardDescription: next, theme });
  };

  const handleThemeChange = (t: Theme) => {
    setLocalTheme(t);
    saveSettings.mutate({ forwardDescription: forward, theme: t });
    setTheme(t);
  };

  const handleModelSave = () => {
    saveModel.mutate({ model });
  };

  const handleAgentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setDefaultAgent(e.target.value);
    setAgentDirty(true);
  };

  const handleAgentSave = () => {
    saveAgent.mutate({ default_agent: defaultAgent });
  };

  const isLoading = settingsLoading || cfgLoading;

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Settings2 size={16} className="text-zinc-400" />
          <h2 className="text-lg font-semibold text-white">Settings</h2>
        </div>
        <p className="text-sm text-zinc-500">
          Configure OpenTack and default model for opencode.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-zinc-600">Loading settings…</p>
      ) : (
        <>
          {/* ── Section 1: Prompting ─────────────────────────────────── */}
          <SectionCard
            icon={<Send size={14} />}
            title="Prompting"
            description="When enabled, the ticket description is used to generate an improved prompt for opencode when starting a new session."
          >
            <label className="flex items-center justify-between cursor-pointer group">
              <span className="text-sm text-zinc-300 group-hover:text-zinc-200 transition-colors">
                Improve initial prompt with AI
              </span>
              <button
                onClick={handleToggleForward}
                disabled={saveSettings.isPending}
                className={`relative w-10 h-5 rounded-full transition-colors duration-200 ${
                  forward ? "bg-[var(--accent)]" : "bg-zinc-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200 ${
                    forward ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </label>
          </SectionCard>

          {/* ── Section 2: Appearance ───────────────────────────────── */}
          <SectionCard
            icon={<Palette size={14} />}
            title="Appearance"
            description="Choose your accent color theme."
          >
            <ThemePicker value={theme} onChange={handleThemeChange} />
          </SectionCard>

          {/* ── Section 3: Model ────────────────────────────────────── */}
          <SectionCard
            icon={<Cpu size={14} />}
            title="Default Model"
            description="Default model for new opencode sessions. Saved to opencode.json."
          >
            <div className="flex items-center gap-2">
              <input
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600 font-mono"
                placeholder="opencode/big-pickle"
                value={model}
                onChange={(e) => { setModel(e.target.value); setModelDirty(true); }}
              />
              <button
                onClick={handleModelSave}
                disabled={saveModel.isPending || !modelDirty}
                className="btn-primary !text-xs"
              >
                <Save size={12} />
                {saveModel.isPending ? "Saving..." : "Save"}
              </button>
            </div>
            <p className="text-xs text-zinc-600 mt-2">
              Format: <code className="text-zinc-500">providerID/modelID</code>
            </p>
          </SectionCard>

          {/* ── Section 4: Default Agent ────────────────────────────── */}
          <SectionCard
            icon={<Bot size={14} />}
            title="Default Agent"
            description="Default opencode agent for new sessions. Saved to opencode.json."
          >
            <div className="flex items-center gap-2">
              <select
                value={defaultAgent}
                onChange={handleAgentChange}
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-600 appearance-none cursor-pointer"
              >
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}{a.mode ? ` (${a.mode})` : ""}{a.description ? ` — ${a.description}` : ""}
                  </option>
                ))}
              </select>
              <button
                onClick={handleAgentSave}
                disabled={saveAgent.isPending || !agentDirty}
                className="btn-primary !text-xs"
              >
                <Save size={12} />
                {saveAgent.isPending ? "Saving..." : "Save"}
              </button>
            </div>
          </SectionCard>

          {/* ── Section 5: Repo env vars ────────────────────────────── */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-zinc-400"><Settings2 size={14} /></span>
              <h3 className="text-sm font-medium text-white">Repository Environment</h3>
            </div>

            {reposLoading ? (
              <p className="text-sm text-zinc-600">Loading repos…</p>
            ) : repos && repos.length > 0 ? (
              <div className="space-y-4">
                {repos.map((repo) => (
                  <RepoSettingsCard key={repo.id} repo={repo} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-zinc-600 italic">
                No repos added yet. Add one from the sidebar.
              </p>
            )}
          </div>
        </>
      )}
    </div>
    </div>
  );
}
