// @ts-nocheck
"use client";
import React, { useState as useStatep, useEffect as useEffectApp, useRef as useRefApp, useCallback as useCallbackApp } from 'react';
import { STAGE_NAMES } from '@slad/shared';
import { Sidebar } from './sidebar';
import { StageView } from './stage-view';
import { ArtifactPanel } from './artifact-panel';
import { TweaksPanel, TweakSection, TweakColor, TweakRadio, TweakSelect, TweakToggle, useTweaks } from './tweaks-panel';
import { SettingsModal } from './settings-modal';

function PanelDivider({ onDelta }) {
  const divRef = useRefApp(null);
  const onMouseDown = useCallbackApp((e) => {
    e.preventDefault();
    const startX = e.clientX;
    let last = startX;
    divRef.current?.setAttribute("data-dragging", "true");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev) => {
      const dx = ev.clientX - last;
      last = ev.clientX;
      if (dx !== 0) onDelta(dx);
    };
    const onUp = () => {
      divRef.current?.setAttribute("data-dragging", "false");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [onDelta]);
  return <div ref={divRef} className="panel-divider" onMouseDown={onMouseDown} />;
}

// SLAD OS — App root


const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "indigo",
  "density": "regular",
  "harness": "on",
  "showFooter": true,
  "monoFont": "Geist Mono"
}/*EDITMODE-END*/;

const ACCENT_MAP = {
  indigo:  "oklch(0.72 0.14 270)",
  emerald: "oklch(0.72 0.14 150)",
  amber:   "oklch(0.78 0.14 80)",
  rose:    "oklch(0.70 0.18 25)",
  violet:  "oklch(0.72 0.14 305)",
};

const EMPTY_STATE = {
  sessions: [],
  details: {},
  artifacts: {},
  knowledge: [],
  telemetry: { totalRuns: 0, byCommand: { ask: 0, work: 0, "work-debate": 0 }, byStatus: { completed: 0, partial: 0, failed: 0 }, debateRuns: 0, avgDebateConsensus: null, classifierShown: 0, classifierAccepted: 0, avgDurationMs: null },
};

function nextStageFor(sess) {
  if (!sess) return null;
  const idx = sess.stages.findIndex(s => s === "pending" || s === "await" || s === "failed");
  if (idx < 0) return null;
  return STAGE_NAMES[idx];
}

export default function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [mode, setMode] = useStatep("sessions"); // sessions | knowledge | stats
  const [leftWidth, setLeftWidth] = useStatep(288);
  const [rightWidth, setRightWidth] = useStatep(380);
  const [activeId, setActiveId] = useStatep("");
  const [state, setState] = useStatep(EMPTY_STATE);
  const [loading, setLoading] = useStatep(true);
  const [archivingIds, setArchivingIds] = useStatep<string[]>([]);
  const [optimisticArchivedIds, setOptimisticArchivedIds] = useStatep<string[]>([]);
  const [job, setJob] = useStatep(null);
  const [logs, setLogs] = useStatep([]);
  const [cliAgents, setCliAgents] = useStatep<Array<{ binary: string; version: string }>>([]);
  const [selectedAgent, setSelectedAgent] = useStatep<string | undefined>(undefined);
  const [selectedModel, setSelectedModel] = useStatep<string | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useStatep(false);
  const [settingsData, setSettingsData] = useStatep(null);
  const [workspace, setWorkspace] = useStatep<{ trusted: boolean; activeWorkspace: string; trustedPaths: string[]; defaultPath: string } | null>(null);
  const [trustModalOpen, setTrustModalOpen] = useStatep(false);
  const [workspaceDraft, setWorkspaceDraft] = useStatep("");
  const autoTrustShown = useRefApp(false);

  useEffectApp(() => {
    document.documentElement.style.setProperty("--primary", ACCENT_MAP[t.accent] || ACCENT_MAP.indigo);
    document.documentElement.style.setProperty("--font-mono",
      `"${t.monoFont}", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace`);
  }, [t.accent, t.monoFont]);

  const refresh = async () => {
    const res = await fetch("/api/sessions", { cache: "no-store" });
    if (!res.ok) throw new Error(await res.text());
    const next = await res.json();
    setState(next);
    setLoading(false);
    setActiveId(cur => {
      if (cur === "__ask__") return cur;
      const visibleSessions = next.sessions.filter((s) => !s.archivedAt);
      if (cur && visibleSessions.some(s => s.id === cur)) return cur;
      return visibleSessions.find(s => s.isActive)?.id || visibleSessions[0]?.id || "";
    });
    return next;
  };

  useEffectApp(() => {
    refresh().catch(err => {
      console.error(err);
      setLoading(false);
    });
  }, []);

  useEffectApp(() => {
    const url = activeId ? `/api/providers?sessionId=${activeId}` : "/api/providers";
    fetch(url)
      .then(r => r.json())
      .then(data => {
        setCliAgents(data.candidates ?? []);
      })
      .catch(() => {});
  }, [activeId]);

  const loadSettings = async () => {
    const res = await fetch("/api/settings", { cache: "no-store" });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    setSettingsData(data);
    const profile = data.activeProfile;
    setSelectedAgent(profile?.agent || undefined);
    setSelectedModel(profile?.model || undefined);
    if (profile?.id) {
      // Keep the in-memory profile selector aligned with persisted global settings.
      setSelectedAgent(profile.agent || undefined);
      setSelectedModel(profile.model || undefined);
    }
    if (data.effective?.harness?.mode) setTweak("harness", data.effective.harness.mode);
    return data;
  };

  useEffectApp(() => {
    loadSettings().catch(console.error);
  }, []);

  useEffectApp(() => {
    fetch("/api/workspace")
      .then(r => r.json())
      .then(data => { setWorkspace(data); setWorkspaceDraft(data.activeWorkspace); })
      .catch(() => {});
  }, []);

  useEffectApp(() => {
    if (!workspace || autoTrustShown.current) return;
    autoTrustShown.current = true;
    if (!workspace.trusted) setTrustModalOpen(true);
  }, [workspace]);

  // Expose mode setter for KnowledgeView's back button hack.
  if (typeof window !== "undefined") { (window as any).__sladSetMode = setMode; }

  const sessions = state.sessions.filter((s) => !s.archivedAt || optimisticArchivedIds.includes(s.id));
  const details = state.details;
  const artifacts = state.artifacts;
  const knowledge = state.knowledge;
  const telemetry = state.telemetry;
  const sess = sessions.find(s => s.id === activeId);
  const nextStage = nextStageFor(sess);
  const running = job?.status === "running";

  const handleStagePick = (idx) => {
    if (!sess) return;
    setState(cur => ({
      ...cur,
      sessions: cur.sessions.map(s => s.id === sess.id ? { ...s, activeStage: idx } : s),
    }));
  };

  const handleCreateSession = async (rawIntent: string, mode?: string, opts?: { debateProfileId?: string }) => {
    const intent = rawIntent.trim();
    if (intent.length < 3) return;

    const workMode = mode === "work-debate" ? "work-debate" : "work";
    // For work/debate, use the dedicated mode endpoint which creates session + fires pipeline
    if (mode === "work" || mode === "work-debate") {
      let runOpts: { debateModels?: string } | undefined;
      if (mode === "work-debate" && opts?.debateProfileId) {
        const p2 = settingsData?.effective?.profiles?.find((p) => p.id === opts.debateProfileId);
        const model1 = selectedModel || "claude-sonnet-4-6";
        const model2 = p2?.model || "claude-sonnet-4-6";
        runOpts = { debateModels: `${model1},${model2}` };
      }
      await handleRunMode(intent, workMode, runOpts);
      return;
    }

    // Default: create session only (manual stage-by-stage)
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent, agent: selectedAgent, model: selectedModel }),
    });
    if (!res.ok) {
      alert(await res.text());
      return;
    }
    const payload = await res.json();
    setState(payload.state);
    setActiveId(payload.session.id);
    setTimeout(() => {
      fetch(`/api/providers?sessionId=${payload.session.id}`)
        .then(r => r.json())
        .then(data => { setCliAgents(data.candidates ?? []); setSelectedAgent(data.selected || undefined); setSelectedModel(undefined); })
        .catch(() => {});
    }, 1200);
  };

  const handleRunMode = async (intent: string, mode: "ask" | "work" | "work-debate", opts?: { debateModels?: string }) => {
    if (running) return;
    const isAsk = mode === "ask";
    setLogs([]);
    if (isAsk) setActiveId("__ask__");
    const res = await fetch("/api/pipeline/work", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent, mode, agent: selectedAgent, model: selectedModel, debateModels: opts?.debateModels }),
    });
    if (!res.ok) {
      if (isAsk) setActiveId("");
      alert(await res.text());
      return;
    }
    const payload = await res.json();
    const activeJob = { ...payload, status: "running" };
    setJob(activeJob);

    if (!isAsk && payload.state) {
      setState(payload.state);
      if (payload.session?.id) setActiveId(payload.session.id);
    }

    const source = new EventSource(`/api/pipeline/logs?jobId=${payload.jobId}`);
    source.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "log") setLogs(prev => [...prev, msg]);
      if (msg.type === "status") {
        setJob(j => j ? { ...j, status: msg.status, exitCode: msg.exitCode } : j);
        if (msg.status !== "running") {
          source.close();
          if (!isAsk) refresh().catch(console.error);
        }
      }
    };
    source.onerror = () => {
      source.close();
      setJob(j => j ? { ...j, status: "failed" } : j);
    };
  };

  const firstBlockingStageBefore = (stage) => {
    if (!sess || !stage) return null;
    const targetIdx = STAGE_NAMES.indexOf(stage);
    if (targetIdx <= 0) return null;
    const blockingIdx = sess.stages.findIndex((state, idx) => idx < targetIdx && state !== "done");
    return blockingIdx >= 0 ? STAGE_NAMES[blockingIdx] : null;
  };

  const handleRunStage = async (stage = nextStage) => {
    if (!sess || !stage || running) return;
    const prerequisiteStage = firstBlockingStageBefore(stage);
    const stageToRun = prerequisiteStage || stage;
    setLogs([]);
    const harnessMode = settingsData?.effective?.harness?.mode ?? t.harness;
    const res = await fetch("/api/pipeline/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sess.id, stage: stageToRun, agent: selectedAgent, model: selectedModel, harness: harnessMode }),
    });
    if (!res.ok) {
      alert(await res.text());
      return;
    }
    const payload = await res.json();
    const activeJob = { ...payload, status: "running" };
    setJob(activeJob);
    setState(cur => ({
      ...cur,
      sessions: cur.sessions.map(s => {
        if (s.id !== sess.id) return s;
        const idx = STAGE_NAMES.indexOf(stageToRun);
        const stages = [...s.stages];
        if (idx >= 0) stages[idx] = "progress";
        return { ...s, activeStage: idx >= 0 ? idx : s.activeStage, stages };
      }),
    }));
    const source = new EventSource(`/api/pipeline/logs?jobId=${payload.jobId}`);
    source.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "log") {
        setLogs(prev => [...prev, msg]);
      }
      if (msg.type === "status") {
        setJob(j => j ? { ...j, status: msg.status, exitCode: msg.exitCode } : j);
        if (msg.status !== "running") {
          source.close();
          refresh()
            .then((next) => {
              const updated = next?.sessions?.find((s) => s.id === sess.id);
              if (updated && !nextStageFor(updated)) {
                setActiveId("");
              }
            })
            .catch(console.error);
        }
      }
    };
    source.onerror = () => {
      source.close();
      setJob(j => j ? { ...j, status: "failed" } : j);
    };
  };

  const handleStartNewSession = () => {
    setMode("sessions");
    setActiveId("");
    setJob(null);
    setLogs([]);
  };
  const installedAgents = new Set(cliAgents.map((agent) => agent.binary));
  const cliProfiles = (settingsData?.effective?.profiles ?? []).filter((profile) => {
    if (!profile.agent) return true;
    return installedAgents.has(profile.agent);
  }).map((profile) => ({
    value: profile.id,
    label: profile.model ? `${profile.label} · ${profile.model}` : profile.label,
    agent: profile.agent || null,
  }));
  const selectedProfile = settingsData?.effective?.activeProfileId ?? "";
  const handleProfileChange = async (profileId?: string) => {
    if (!profileId) {
      setSelectedAgent(undefined);
      setSelectedModel(undefined);
      return;
    }
    const profile = settingsData?.effective?.profiles?.find((item) => item.id === profileId);
    setSelectedAgent(profile?.agent || undefined);
    setSelectedModel(profile?.model || undefined);
    if (!settingsData?.effective) return;
    const next = { ...settingsData.effective, activeProfileId: profileId };
    setSettingsData((cur) => ({ ...cur, effective: next, activeProfile: profile }));
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: next }),
    }).then(() => loadSettings()).catch(console.error);
  };

  const handleSaveSettings = async (settings) => {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    });
    if (!res.ok) {
      alert(await res.text());
      return;
    }
    const data = await res.json();
    setSettingsData(data);
    setSettingsOpen(false);
    setSelectedAgent(data.activeProfile?.agent || undefined);
    setSelectedModel(data.activeProfile?.model || undefined);
    if (data.effective?.harness?.mode) setTweak("harness", data.effective.harness.mode);
  };

  const handleCancelJob = async () => {
    if (!job?.jobId) return;
    await fetch("/api/pipeline/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: job.jobId }),
    }).catch(() => {});
    setJob(j => j ? { ...j, status: "cancelled" } : j);
    await refresh().catch(() => {});
  };

  const handleEvolveApply = async (decisions: Record<string, string>) => {
    if (!sess) return;
    const res = await fetch("/api/evolve/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sess.id, decisions }),
    });
    if (!res.ok) {
      alert(await res.text());
      return;
    }
    const payload = await res.json();
    if (payload.state) setState(payload.state);
    if (payload.errors?.length) {
      alert(`Algunos cambios fallaron:\n${payload.errors.join("\n")}`);
    }
  };

  const handleArchiveSession = async (sessionId: string) => {
    if (!sessionId || archivingIds.includes(sessionId)) return;
    setArchivingIds((cur) => [...cur, sessionId]);
    setOptimisticArchivedIds((cur) => (cur.includes(sessionId) ? cur : [...cur, sessionId]));
    try {
      const res = await fetch(`/api/sessions/${sessionId}/archive`, { method: "PATCH" });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      await refresh();
      setOptimisticArchivedIds((cur) => cur.filter((id) => id !== sessionId));
    } catch (err) {
      setOptimisticArchivedIds((cur) => cur.filter((id) => id !== sessionId));
      alert(err instanceof Error ? err.message : "No se pudo archivar la sesión.");
    } finally {
      setArchivingIds((cur) => cur.filter((id) => id !== sessionId));
    }
  };

  const handleTrustWorkspace = async (workspacePath: string) => {
    const res = await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspacePath }),
    });
    if (!res.ok) { alert(await res.text()); return; }
    const data = await res.json();
    setWorkspace(data);
    setTrustModalOpen(false);
  };

  const handleSubmitHitl = async ({ stage, taskId, answers }) => {
    if (!sess) return;
    const normalized = Object.fromEntries(
      Object.entries(answers || {}).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== ""),
    );
    if (Object.keys(normalized).length === 0) {
      alert("Responde al menos una pregunta antes de continuar.");
      return;
    }
    const res = await fetch("/api/hitl/answers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sess.id, stage, taskId, answers: normalized }),
    });
    if (!res.ok) {
      alert(await res.text());
      return;
    }
    const payload = await res.json();
    if (payload.state) setState(payload.state);
    const aborted = Object.values(normalized).some(v => v === "__abort__");
    if (!aborted) {
      await handleRunStage(stage);
    }
  };

  return (
    <div className="app" data-density={t.density}>
      <div className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          <span>SLAD</span>
        </div>
        <span className="crumb">
          <span>~/proyectos/slad-core</span>
          <span style={{ color: "var(--fg-4)" }}>›</span>
          <b>{sess ? sess.intent.slice(0, 48) + (sess.intent.length > 48 ? "…" : "") : "no session"}</b>
        </span>
        <div className="spacer" />
        {workspace && (
          <button
            onClick={() => { setWorkspaceDraft(workspace.activeWorkspace); setTrustModalOpen(true); }}
            title={workspace.trusted ? `Workspace: ${workspace.activeWorkspace}` : "Sin workspace de confianza — click para configurar"}
            style={{
              background: "none", border: "none", cursor: "pointer",
              display: "flex", alignItems: "center", gap: 5,
              padding: "2px 8px", borderRadius: "var(--radius-md)",
              color: workspace.trusted ? "var(--fg-3)" : "var(--acc-await)",
              fontSize: "11.5px", fontFamily: "var(--font-mono)",
            }}
          >
            <span style={{ fontSize: 13 }}>{workspace.trusted ? "⚿" : "⚠"}</span>
            <span style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {workspace.trusted
                ? workspace.activeWorkspace.split("/").slice(-2).join("/")
                : "sin workspace"}
            </span>
          </button>
        )}
        <span style={{ color: "var(--fg-3)" }}>{loading ? "loading…" : `${sessions.length} sessions`}</span>
        {sess && nextStage && (
          <button
            className="btn primary sm"
            onClick={() => handleRunStage(nextStage)}
            disabled={running}
            title="Ejecutar siguiente etapa del pipeline"
          >{running ? "running…" : `Run ${nextStage}`}</button>
        )}
        <button
          className="btn ghost sm"
          onClick={refresh}
          title="Refresh sessions"
          style={{ marginLeft: 6 }}
        >Refresh</button>
        <button
          className="btn ghost sm"
          onClick={handleStartNewSession}
          title="Crear nueva sesión"
          style={{ marginLeft: 6 }}
        >New session</button>
        <button
          className="btn ghost sm"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          style={{ marginLeft: 6 }}
        >Settings</button>
      </div>
      <div className="shell">
        <div style={{ width: leftWidth, flexShrink: 0, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <Sidebar
            sessions={sessions}
            activeId={activeId}
            onPick={setActiveId}
            archivingIds={archivingIds}
            optimisticArchivedIds={optimisticArchivedIds}
            onArchiveSession={handleArchiveSession}
            mode={mode}
            onMode={setMode}
            onNewSession={handleStartNewSession}
            knowledge={knowledge}
            telemetry={telemetry}
          />
        </div>
        <PanelDivider onDelta={(dx) => setLeftWidth(w => Math.max(180, Math.min(520, w + dx)))} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <StageView
            sess={sess}
            detail={sess ? details[sess.id] : {}}
            logs={logs}
            job={job}
            nextStage={nextStage}
            onRunStage={handleRunStage}
            onCancelJob={handleCancelJob}
            onStagePick={handleStagePick}
            onSubmitHitl={handleSubmitHitl}
            onEvolveApply={handleEvolveApply}
            cliProfiles={cliProfiles}
            selectedProfile={selectedProfile}
            onProfileChange={handleProfileChange}
            onCreateSession={handleCreateSession}
            onRunMode={handleRunMode}
          />
        </div>
        <PanelDivider onDelta={(dx) => setRightWidth(w => Math.max(200, Math.min(620, w - dx)))} />
        <div style={{ width: rightWidth, flexShrink: 0, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <ArtifactPanel sess={sess} detail={sess ? details[sess.id] : {}} artifacts={artifacts} tweaks={t} setTweak={setTweak} />
        </div>
      </div>

      {trustModalOpen && (
        <WorkspaceTrustModal
          workspacePath={workspaceDraft}
          onPathChange={setWorkspaceDraft}
          onTrust={() => handleTrustWorkspace(workspaceDraft)}
          onClose={() => setTrustModalOpen(false)}
        />
      )}

      <SettingsModal
        open={settingsOpen}
        data={settingsData}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveSettings}
      />

      <TweaksPanel>
        <TweakSection label="Theme" />
        <TweakColor label="Accent" value={t.accent}
          options={["indigo","emerald","amber","rose","violet"]}
          onChange={v => setTweak("accent", v)} />
        <TweakRadio label="Density" value={t.density}
          options={["compact","regular","comfy"]}
          onChange={v => setTweak("density", v)} />
        <TweakSection label="Pipeline" />
        <TweakRadio label="Harness" value={t.harness}
          options={["off","on","strict"]}
          onChange={v => setTweak("harness", v)} />
        <TweakSection label="Navigation" />
        <TweakSelect label="Sesión activa" value={activeId}
          options={sessions.map(s => ({ value: s.id, label: `${s.id} — ${s.intent.slice(0,38)}…` }))}
          onChange={v => { setActiveId(v); }} />
        <TweakRadio label="Panel izquierdo" value={mode}
          options={["sessions","knowledge","stats"]} onChange={setMode} />
        <TweakSelect label="Stage activo" value={String(sess?.activeStage ?? 0)}
          options={STAGE_NAMES.map((n, i) => ({ value: String(i), label: `${i}. ${n}` }))}
          onChange={v => handleStagePick(+v)} />
      </TweaksPanel>
    </div>
  );
}

export function WorkspaceTrustModal({ workspacePath, onPathChange, onTrust, onClose }) {
  const [browsing, setBrowsing] = useStatep(false);

  const handleBrowse = async () => {
    setBrowsing(true);
    try {
      const res = await fetch("/api/workspace/browse", { method: "POST" });
      const data = await res.json();
      if (data.path) onPathChange(data.path);
    } finally {
      setBrowsing(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" style={{ maxWidth: 480 }} onMouseDown={e => e.stopPropagation()}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "36px 32px 24px", gap: 16, textAlign: "center" }}>
          <div style={{
            width: 52, height: 52, borderRadius: 12,
            background: "var(--bg-1)", border: "1px solid var(--border-strong)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 24,
          }}>⚿</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-1)", marginBottom: 8 }}>
              ¿Confías en este workspace?
            </div>
            <div style={{ fontSize: 12.5, color: "var(--fg-3)", lineHeight: 1.7, maxWidth: 360 }}>
              SLAD leerá y escribirá archivos en este directorio durante todas las etapas del pipeline — explore, plan, run, evolve. Solo dale acceso a proyectos en los que confíes.
            </div>
          </div>
        </div>
        <div style={{ padding: "0 24px 28px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: "var(--fg-4)", fontFamily: "var(--font-mono)", marginBottom: 6, letterSpacing: "0.05em", textTransform: "uppercase" }}>
              Directorio del workspace
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                value={workspacePath}
                onChange={e => onPathChange(e.target.value)}
                placeholder="/Users/tu/mi-proyecto"
                style={{
                  flex: 1, minWidth: 0, boxSizing: "border-box",
                  background: "var(--bg-1)", border: "1px solid var(--border-2)",
                  borderRadius: "var(--radius-md)", color: "var(--fg-1)",
                  fontFamily: "var(--font-mono)", fontSize: "12px",
                  padding: "8px 12px", outline: "none",
                }}
              />
              <button
                className="btn ghost"
                style={{ whiteSpace: "nowrap", flexShrink: 0 }}
                onClick={handleBrowse}
                disabled={browsing}
              >
                {browsing ? "..." : "Explorar"}
              </button>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button className="btn ghost" style={{ flex: 1 }} onClick={onClose}>
              No por ahora
            </button>
            <button
              className="btn primary"
              style={{ flex: 2 }}
              disabled={!workspacePath.trim()}
              onClick={onTrust}
            >
              Confiar en este workspace
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
