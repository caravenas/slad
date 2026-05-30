// @ts-nocheck
"use client";
import React, { useState, useEffect, useRef, useMemo, Fragment } from 'react';
import { STAGE_NAMES } from '@slad/shared';
import { StageDots, Chip, Tag, Breadcrumb, JsonTree, ProviderChip, HarnessSeg, STAGE_GLYPHS, fmtUsd, fmtTokens } from './components';

// SLAD OS — Stage view (center panel)



export function StageView({ sess, detail: detailProp, logs = [], job, nextStage, onRunStage, onCancelJob, onStagePick, onSubmitHitl, onEvolveApply, cliProfiles = [], selectedProfile, onProfileChange, onCreateSession, onRunMode }) {
  if (!sess) {
    // ask mode — no session, but job may be running/done
    if (job && (job.stage === "ask" || logs.length > 0)) {
      return (
        <div className="panel">
          <div className="pipeline-controls">
            <div>
              <span className="mono" style={{ color: "var(--fg-3)" }}>ask</span>
              <span className="faint"> · </span>
              <span>{job.status === "running" ? "respondiendo…" : job.status}</span>
            </div>
            {job.status === "running" && (
              <button className="btn danger sm" onClick={onCancelJob}>Cancel</button>
            )}
          </div>
          <div className="stageview" style={{ flex: 1, minHeight: 0 }}>
            <div className="stage-body">
              <AskResultView logs={logs} job={job} />
            </div>
          </div>
        </div>
      );
    }
    return (
      <EmptyState
        onCreateSession={onCreateSession}
        onRunMode={onRunMode}
        cliProfiles={cliProfiles}
        selectedProfile={selectedProfile}
        onProfileChange={onProfileChange}
      />
    );
  }
  const stageIdx = sess.activeStage;
  const stageName = STAGE_NAMES[stageIdx];
  const detail = detailProp || {};
  const hitlQuestions = detail.questionsByStage?.[stageName] || (stageIdx === 3 ? detail.questions || [] : []);
  const isAwaitingHuman = sess.stages[stageIdx] === "await" && hitlQuestions.length > 0;
  return (
    <div className="panel">
      <Breadcrumb stages={sess.stages} activeIdx={stageIdx} onPick={onStagePick} />
      <PipelineControls
        sess={sess}
        stageName={stageName}
        nextStage={nextStage}
        job={job}
        onRunStage={onRunStage}
        onCancelJob={onCancelJob}
        cliProfiles={cliProfiles}
        selectedProfile={selectedProfile}
        onProfileChange={onProfileChange}
      />
      <div className="stageview" style={{ flex: 1, minHeight: 0 }}>
        <div className="stage-body">
          {stageIdx === 0 && (sess.stages[0] === "pending" ? <StagePending name="explore" /> : <ExploreStage sess={sess} detail={detail} />)}
          {stageIdx === 1 && (sess.stages[1] === "pending" ? <StagePending name="snapshot" /> : <SnapshotStage sess={sess} detail={detail} />)}
          {stageIdx === 2 && (sess.stages[2] === "pending" ? <StagePending name="plan" /> : <PlanStage sess={sess} detail={detail} />)}
          {stageIdx === 3 && sess.stages[3] === "pending" && <StagePending name="run" />}
          {stageIdx === 3 && sess.stages[3] !== "pending" && sess.runMode === "hitl" && <RunStage sess={sess} detail={detail} hitl />}
          {stageIdx === 3 && sess.stages[3] !== "pending" && sess.runMode !== "hitl" && <RunStage sess={sess} detail={detail} />}
          {stageIdx === 4 && (sess.stages[4] === "pending" ? <StagePending name="learn" /> : <LearnStage sess={sess} detail={detail} />)}
          {stageIdx === 5 && (sess.stages[5] === "pending" ? <StagePending name="evolve" /> : <EvolveStage sess={sess} detail={detail} onApply={onEvolveApply} />)}
          {logs.length > 0 && <LiveLog logs={logs} job={job} />}
        </div>
        {isAwaitingHuman && (
          <HitlInput
            sess={sess}
            stageName={stageName}
            taskId={stageIdx === 3 ? detail.runActiveTask : stageName}
            questions={hitlQuestions}
            onSubmit={(answers) => onSubmitHitl && onSubmitHitl({ stage: stageName, taskId: stageIdx === 3 ? detail.runActiveTask : stageName, answers })}
          />
        )}
        {!isAwaitingHuman && (stageIdx === 0 || stageIdx === 1 || stageIdx === 2) && (
          <Composer 
            placeholder={
              stageIdx === 0 ? "Escribe / para habilidades o refina la intención..." :
              stageIdx === 1 ? "Ajustar Snapshot o continuar..." :
              "Modificar el Plan antes de ejecución..."
            }
          />
        )}
      </div>
    </div>
  );
}

export function PipelineControls({ sess, stageName, nextStage, job, onRunStage, onCancelJob, cliProfiles = [], selectedProfile, onProfileChange }) {
  const running = job?.status === "running";
  const hasProfiles = cliProfiles.length > 0;
  return (
    <div className="pipeline-controls">
      <div>
        <span className="mono">{sess.id}</span>
        <span className="faint"> · </span>
        <span>{nextStage ? `next: ${nextStage}` : "pipeline complete"}</span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {hasProfiles && (
          <select
            value={selectedProfile ?? ""}
            onChange={e => onProfileChange && onProfileChange(e.target.value || undefined)}
            disabled={running}
            style={{
              appearance: "none",
              background: "var(--bg-1)",
              border: "1px solid var(--border-2)",
              borderRadius: "var(--radius-md)",
              color: selectedProfile ? "var(--fg-1)" : "var(--fg-3)",
              fontFamily: "var(--font-mono)",
              fontSize: "11.5px",
              padding: "3px 24px 3px 8px",
              cursor: "default",
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23666' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`,
              backgroundRepeat: "no-repeat",
              backgroundPosition: "right 7px center",
            }}
          >
            <option value="">profile: default</option>
            {cliProfiles.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        )}
        {running && (
          <button className="btn danger sm" onClick={onCancelJob}>
            Cancel
          </button>
        )}
        {!running && (
          <button className="btn ghost sm" onClick={() => onRunStage(stageName)}>
            Rerun {stageName}
          </button>
        )}
        {!running && nextStage && (
          <button className="btn primary sm" onClick={() => onRunStage(nextStage)}>
            Run {nextStage}
          </button>
        )}
      </div>
    </div>
  );
}

export function LiveLog({ logs, job }) {
  return (
    <div className="card live-log">
      <div className="card-hdr">
        <span className="title">Live logs</span>
        <span className="dim">{job?.status || "running"}</span>
      </div>
      <div className="log-body">
        {logs.map((row, i) => (
          <div key={i} className="log-line" data-stream={row.stream}>
            <span>{row.stream}</span>
            <code>{row.line}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────── Stage pending ───────── */

const STAGE_DESCRIPTIONS = {
  explore: "Analiza la intención y genera enfoques, riesgos y next steps.",
  snapshot: "Produce el mini-spec — el contrato entre explore y plan.",
  plan: "Convierte el snapshot en un DAG de tasks tipadas.",
  run: "Ejecuta las tasks del plan con el Builder/Reviewer loop.",
  learn: "Extrae decisiones, patrones y errores de los runs.",
  evolve: "Propone actualizaciones a la wiki y AGENTS.md.",
};

export function StagePending({ name }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", padding: "60px 24px", textAlign: "center" }}>
      <div style={{ width: 40, height: 40, borderRadius: 8, border: "1px solid var(--border-strong)", background: "var(--bg-1)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontSize: 16, color: "var(--fg-4)", marginBottom: 14 }}>
        ·
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-1)", letterSpacing: "-0.01em", marginBottom: 6 }}>{name}</div>
      <div style={{ fontSize: 12.5, color: "var(--fg-3)", maxWidth: 320 }}>{STAGE_DESCRIPTIONS[name] ?? ""}</div>
    </div>
  );
}

/* ───────── Empty ───────── */

/* ───────── Ask result (no session) ───────── */


export function AskResultView({ logs, job }) {
  const bodyRef = useRef(null);
  // Auto-scroll on new logs
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [logs.length]);

  // Collect stdout lines as the response
  const responseLines = logs.filter(l => l.stream === "stdout").map(l => l.line);
  const systemLines = logs.filter(l => l.stream === "system" || l.stream === "stderr");
  const done = job?.status !== "running";

  return (
    <div>
      <div className="stage-title-row">
        <div>
          <h2>Ask</h2>
          <div className="sub">Respuesta directa · sin pipeline · sin sesión.</div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {!done && (
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--acc-progress)" }}>
              <span style={{ width: 6, height: 6, borderRadius: 3, background: "var(--acc-progress)", display: "inline-block", animation: "pulse 1.6s infinite" }} />
              respondiendo…
            </span>
          )}
          {done && <Chip state={job?.exitCode === 0 ? "done" : "failed"}>{job?.exitCode === 0 ? "✓ completo" : "✗ error"}</Chip>}
        </div>
      </div>
      {responseLines.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-hdr"><span className="title">Respuesta</span></div>
          <div className="card-body" ref={bodyRef} style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-sans)", lineHeight: 1.65, fontSize: 13, maxHeight: 480, overflowY: "auto" }}>
            {responseLines.join("\n")}
          </div>
        </div>
      )}
      {systemLines.length > 0 && (
        <div className="card live-log" style={{ marginTop: 8 }}>
          <div className="card-hdr"><span className="title dim">Sistema</span></div>
          <div className="log-body" style={{ maxHeight: 120 }}>
            {systemLines.map((l, i) => (
              <div key={i} className="log-line" data-stream={l.stream}>
                <span>{l.stream}</span>
                <code>{l.line}</code>
              </div>
            ))}
          </div>
        </div>
      )}
      {!done && responseLines.length === 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "24px 0", color: "var(--fg-3)", fontSize: 12.5 }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: "var(--acc-progress)", display: "inline-block", animation: "pulse 1.6s infinite" }} />
          Esperando respuesta del modelo…
        </div>
      )}
    </div>
  );
}

const MODE_META = {
  ask: {
    label: "Ask",
    glyph: "?",
    desc: "Una respuesta directa — sin pipeline, sin sesión. Para preguntas puntuales.",
    placeholder: "¿Cuál es la diferencia entre reversibility hard y permanent?",
    color: "var(--fg-3)",
  },
  work: {
    label: "Work",
    glyph: "→",
    desc: "Pipeline completo: explore → snapshot → plan → run → learn.",
    placeholder: "Agregar función formatDuration en src/utils/format.ts…",
    color: "var(--primary)",
  },
  "work-debate": {
    label: "Debate",
    glyph: "⟷",
    desc: "Dos modelos en paralelo para explore y plan, árbitro consolida. Mejor para decisiones de arquitectura.",
    placeholder: "¿Debería usar SQLite o DuckDB para persistencia local?",
    color: "var(--acc-await)",
  },
};

export function EmptyState({ onCreateSession, onRunMode, cliProfiles = [], selectedProfile, onProfileChange }) {
  const [intent, setIntent] = useState("");
  const [mode, setMode] = useState("work");
  const [debateProfileId, setDebateProfileId] = useState("");
  const meta = MODE_META[mode] || MODE_META.work;
  const canSubmit = intent.trim().length >= 3;
  const hasProfiles = cliProfiles.length > 0;
  const isDebate = mode === "work-debate";

  // Debate second profile must share the same agent/provider as primary — cross-provider debate is not supported.
  const primaryAgent = cliProfiles.find(p => p.value === selectedProfile)?.agent ?? null;
  const debateCompatibleProfiles = cliProfiles.filter(p => !primaryAgent || !p.agent || p.agent === primaryAgent);

  const submit = (m = mode) => {
    const q = intent.trim();
    if (q.length < 3) return;
    if (m === "ask") {
      onRunMode?.(q, "ask");
    } else {
      const opts = m === "work-debate" ? { debateProfileId: debateProfileId || undefined } : undefined;
      onCreateSession?.(q, m, opts);
    }
    setIntent("");
  };

  return (
    <div className="panel">
      <div className="empty">
        <div className="mark">↳</div>
        <h1>¿Cuál es tu intención?</h1>
        <p>Elige un modo: <b>Ask</b> para preguntas rápidas, <b>Work</b> para el pipeline completo, <b>Debate</b> para decisiones con múltiples modelos.</p>
      </div>

      {/* Mode selector */}
      <div style={{ display: "flex", gap: 8, padding: "0 16px 12px", justifyContent: "center" }}>
        {Object.entries(MODE_META).map(([m, info]) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              gap: 4, padding: "10px 18px", borderRadius: "var(--radius-md)",
              border: `1px solid ${mode === m ? info.color : "var(--border-2)"}`,
              background: mode === m ? `color-mix(in oklch, ${info.color} 10%, var(--bg-1))` : "var(--bg-1)",
              color: mode === m ? info.color : "var(--fg-3)",
              cursor: "default", transition: "all 0.15s", minWidth: 90,
            }}
          >
            <span style={{ fontSize: 18, lineHeight: 1 }}>{info.glyph}</span>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{info.label}</span>
          </button>
        ))}
      </div>
      <div style={{ padding: "0 16px 16px", fontSize: 12, color: "var(--fg-3)", textAlign: "center" }}>
        {meta.desc}
      </div>

      <div className="composer-wrapper">
        <div className="composer">
          <textarea
            placeholder={meta.placeholder}
            className="composer-input"
            rows={2}
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
            }}
          />
          <div className="composer-footer" style={{ justifyContent: "flex-end" }}>
            {hasProfiles && (
              <select
                value={selectedProfile ?? ""}
                onChange={e => onProfileChange && onProfileChange(e.target.value || undefined)}
                style={{
                  appearance: "none", background: "var(--bg-1)",
                  border: "1px solid var(--border-2)", borderRadius: "var(--radius-md)",
                  color: selectedProfile ? "var(--fg-1)" : "var(--fg-3)",
                  fontFamily: "var(--font-mono)", fontSize: "11.5px",
                  padding: "3px 24px 3px 8px", cursor: "default",
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23666' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`,
                  backgroundRepeat: "no-repeat", backgroundPosition: "right 7px center",
                  marginRight: 8,
                }}
              >
                <option value="">profile: default</option>
                {cliProfiles.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            )}
            {isDebate && hasProfiles && debateCompatibleProfiles.length > 0 && (
              <>
                <span style={{ color: "var(--fg-4)", fontSize: 12, marginRight: 8, flexShrink: 0 }}>vs</span>
                <select
                  value={debateCompatibleProfiles.some(p => p.value === debateProfileId) ? debateProfileId : ""}
                  onChange={e => setDebateProfileId(e.target.value)}
                  style={{
                    appearance: "none", background: "var(--bg-1)",
                    border: "1px solid var(--border-2)", borderRadius: "var(--radius-md)",
                    color: debateProfileId ? "var(--fg-1)" : "var(--fg-3)",
                    fontFamily: "var(--font-mono)", fontSize: "11.5px",
                    padding: "3px 24px 3px 8px", cursor: "default",
                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23666' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`,
                    backgroundRepeat: "no-repeat", backgroundPosition: "right 7px center",
                    marginRight: 8,
                  }}
                >
                  <option value="">profile: default</option>
                  {debateCompatibleProfiles.map(p => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </>
            )}
            <div className="composer-actions">
              <button
                className="btn primary sm"
                onClick={() => submit()}
                disabled={!canSubmit}
                style={{ background: meta.color !== "var(--primary)" ? meta.color : undefined }}
              >
                {mode === "ask" ? "Ask" : mode === "work-debate" ? "Debate" : "Work"}
                <span style={{ opacity: 0.5, marginLeft: 6, fontSize: 10 }}>⌘⏎</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────── Decision helpers ───────── */

const REVERSIBILITY_COLOR = {
  trivial: "var(--acc-done)",
  moderate: "var(--fg-3)",
  hard: "var(--acc-await)",
  permanent: "var(--acc-failed)",
};

function ReversibilityBadge({ level }) {
  const color = REVERSIBILITY_COLOR[level] || "var(--fg-3)";
  return (
    <span style={{
      display: "inline-block",
      padding: "1px 6px",
      borderRadius: 3,
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: "0.04em",
      textTransform: "uppercase",
      background: `color-mix(in oklch, ${color} 15%, transparent)`,
      color,
      border: `1px solid color-mix(in oklch, ${color} 30%, transparent)`,
    }}>
      {level}
    </span>
  );
}

function DecisionCard({ d }) {
  return (
    <div className="card" style={{ padding: "10px 14px", marginBottom: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
        <ReversibilityBadge level={d.reversibility} />
        <span style={{ fontSize: 11, color: "var(--fg-3)", fontFamily: "var(--font-mono)" }}>{d.stage}</span>
        {d.confidence !== undefined && (
          <span style={{ fontSize: 11, color: "var(--fg-4)", marginLeft: "auto" }}>
            {Math.round(d.confidence * 100)}% confidence
          </span>
        )}
      </div>
      <div style={{ fontWeight: 500, fontSize: 13, color: "var(--fg-1)", lineHeight: 1.4, marginBottom: d.rationale || d.alternatives?.length ? 6 : 0 }}>
        {d.decision}
      </div>
      {d.rationale && (
        <div style={{ fontSize: 12, color: "var(--fg-3)", lineHeight: 1.5, marginBottom: d.alternatives?.length ? 4 : 0 }}>
          {d.rationale}
        </div>
      )}
      {d.alternatives?.length > 0 && (
        <div style={{ fontSize: 11, color: "var(--fg-4)", lineHeight: 1.5 }}>
          <span style={{ color: "var(--fg-3)", fontWeight: 500 }}>Alternatives: </span>
          {d.alternatives.map((alt, i) => (
            <span key={i}>
              <b style={{ color: "var(--fg-2)" }}>{alt.option}</b> — {alt.rejectedBecause}{i < d.alternatives.length - 1 ? "; " : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function DecisionsSection({ decisions, stage }) {
  const filtered = stage ? decisions.filter(d => d.stage === stage) : decisions;
  if (!filtered.length) return null;
  return (
    <>
      <div className="section-label" style={{ padding: "18px 0 8px" }}>
        Decisiones{stage ? ` · ${stage}` : ""} ({filtered.length})
      </div>
      {filtered.map(d => <DecisionCard key={d.id} d={d} />)}
    </>
  );
}

/* ───────── Explore ───────── */

export function ExploreStage({ sess, detail }) {
  const explore = detail.explore;
  if (explore) {
    const approaches = Array.isArray(explore.approaches) ? explore.approaches : [];
    return (
      <div>
        <div className="stage-title-row">
          <div>
            <h2>Explore</h2>
            <div className="sub">Artifact real persistido para esta sesión.</div>
          </div>
          <Chip state={explore.status === "awaiting_human" ? "await" : "done"}>{String(explore.status || "completed")}</Chip>
        </div>
        <div className="reframe">
          <div className="lbl">Reframed intent</div>
          <div className="txt">{String(explore.reframing || explore.intent || sess.intent)}</div>
        </div>
        {approaches.length > 0 && (
          <>
            <div className="section-label" style={{ padding: "4px 0 8px" }}>Enfoques considerados</div>
            <div className="approach-grid">
              {approaches.map((a, i) => (
                <div key={i} className="approach">
                  <div className="ah"><span>opción {i + 1}</span></div>
                  <div className="at">{String(a.name || "Approach")}</div>
                  <div className="pc">
                    <div>{String(a.summary || "")}</div>
                    {(Array.isArray(a.pros) ? a.pros : []).map((x, j) => <div key={"p"+j}><span className="l">+</span> {String(x)}</div>)}
                    {(Array.isArray(a.cons) ? a.cons : []).map((x, j) => <div key={"c"+j}><span className="l-bad">-</span> {String(x)}</div>)}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        {Array.isArray(explore.risks) && explore.risks.length > 0 && (
          <>
            <div className="section-label" style={{ padding: "18px 0 8px" }}>Riesgos</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }}>
              {explore.risks.map((risk, i) => <li key={i}>{String(risk)}</li>)}
            </ul>
          </>
        )}
        {Array.isArray(detail.decisions) && <DecisionsSection decisions={detail.decisions} stage="explore" />}
      </div>
    );
  }
  return null;
}

/* ───────── Snapshot ───────── */

export function SnapshotStage({ sess, detail }) {
  const snapshot = detail.snapshot;
  const [open, setOpen] = useState({ build: true, no: true, accept: true });
  const toggle = k => setOpen(o => ({ ...o, [k]: !o[k] }));
  if (snapshot) {
    return (
      <div>
        <div className="stage-title-row">
          <div>
            <h2>Snapshot</h2>
            <div className="sub">Mini-spec persistido para esta sesión.</div>
          </div>
          <Chip state={snapshot.status === "awaiting_human" ? "await" : "done"}>{String(snapshot.status || "completed")}</Chip>
        </div>
        <div className="card">
          <div className="card-hdr"><span className="title">Snapshot content</span><span className="dim mono">markdown</span></div>
          <div className="card-body markdown-ish">
            {String(snapshot.content || "").split(/\n{2,}/).slice(0, 10).map((para, i) => <p key={i}>{para}</p>)}
          </div>
        </div>
      </div>
    );
  }
  return null;
}

export function Collap({ title, open, onToggle, children }) {
  return (
    <div className="collap">
      <div className="collap-hdr" onClick={onToggle}>
        <span className="twg">{open ? "▼" : "▶"}</span> {title}
      </div>
      {open && <div className="collap-body">{children}</div>}
    </div>
  );
}

/* ───────── Plan (DAG) ───────── */

export function PlanStage({ sess, detail }) {
  const tasks = (detail.plan && detail.plan.tasks) || [];
  // Build rows by dep-depth.
  const depthMap = {};
  const compute = t => {
    if (!t) return 0;
    if (depthMap[t.id] != null) return depthMap[t.id];
    if (!t.deps.length) return (depthMap[t.id] = 0);
    const d = Math.max(0, ...t.deps.map(d => compute(tasks.find(x => x.id === d)))) + 1;
    return (depthMap[t.id] = d);
  };
  tasks.forEach(compute);
  const rows = {};
  tasks.forEach(t => {
    rows[depthMap[t.id]] = rows[depthMap[t.id]] || [];
    rows[depthMap[t.id]].push(t);
  });
  const [active, setActive] = useState("T3");
  useEffect(() => {
    if (tasks.length && !tasks.find(t => t.id === active)) setActive(tasks[0].id);
  }, [tasks.length]);
  return (
    <div>
      <div className="stage-title-row">
        <div>
          <h2>Plan</h2>
          <div className="sub">{tasks.length} tasks · DAG por dependencias · cada nodo es un contrato.</div>
        </div>
        <Chip state="done">✓ plan generado</Chip>
      </div>
      <div className="dag">
        {tasks.length === 0 && <div className="card"><div className="card-body dim">Sin plan persistido todavía. Ejecuta la etapa plan para generar tasks.</div></div>}
        {Object.keys(rows).sort((a, b) => +a - +b).map(d => (
          <React.Fragment key={d}>
            <div className="dag-row">
              {rows[d].map(t => (
                <div
                  key={t.id}
                  className="dag-node"
                  data-active={active === t.id ? "true" : "false"}
                  onClick={() => setActive(t.id)}
                >
                  <div className="nid">
                    <span>{t.id}</span>
                    <span>{t.deps.length ? "deps: " + t.deps.join(", ") : "no deps"}</span>
                  </div>
                  <div className="ntitle">{t.title}</div>
                  <div className="nfiles">{t.files.join(" · ")}</div>
                </div>
              ))}
            </div>
            {+d < Math.max(...Object.keys(rows).map(Number)) && <div className="dag-deps">↓</div>}
          </React.Fragment>
        ))}
      </div>
      {(() => {
        const t = tasks.find(x => x.id === active);
        if (!t) return null;
        return (
          <div className="card" style={{ marginTop: 18 }}>
            <div className="card-hdr">
              <span className="title">{t.id} · {t.title}</span>
              <span className="dim">deps: {t.deps.join(", ") || "—"}</span>
            </div>
            <div className="card-body">
              <div className="kv"><span className="k">accept</span><span className="v">{t.accept}</span></div>
              <div className="kv"><span className="k">files</span><span className="v mono">{t.files.join(", ")}</span></div>
              <div className="kv"><span className="k">verify</span><span className="v mono">{t.verify.join(" · ")}</span></div>
            </div>
          </div>
        );
      })()}
      {Array.isArray(detail.decisions) && <DecisionsSection decisions={detail.decisions} stage="plan" />}
    </div>
  );
}

/* ───────── Run ───────── */

export function RunStage({ sess, detail, hitl }) {
  const failed = sess.stages?.[3] === "failed";
  const statusLabel = hitl
    ? " · awaiting human"
    : failed
      ? " · failed"
      : sess.runMode === "live"
        ? " · live"
        : "";
  return (
    <div>
      <div className="stage-title-row">
        <div>
          <h2>Run · {detail.runActiveTask || "T?"}{statusLabel}</h2>
          <div className="sub">Builder/Reviewer loop. Tool calls visibles como rows.</div>
        </div>
        <div className="row gap-6">
          {hitl
            ? <Chip state="await">⏸ HITL round {sess.hitlRound}/{sess.hitlMax}</Chip>
            : failed
              ? <Chip state="failed">✗ blocked/failed</Chip>
              : <Chip state="progress">◐ running</Chip>}
          {!hitl && !failed && <Tag v="cache">cache · saved $0.21</Tag>}
        </div>
      </div>
      <div className="run-thread">
        {(detail.runThread || []).map((row, i) => {
          if (row.kind === "section") {
            return <div key={i} className="tool-row" data-kind="section">{row.text}</div>;
          }
          if (row.kind === "thought") {
            return <div key={i} className="tool-row" data-kind="thought">
              <span /><span className="ic">∴</span><span className="nm">{row.text}</span><span />
            </div>;
          }
          return (
            <div key={i} className="tool-row">
              <span className="ts">{row.ts}</span>
              <span className="ic">{row.icon}</span>
              <span className="nm"><b>{row.name}</b><span className="arg">({row.arg})</span></span>
              <span className="meta">{row.meta}</span>
            </div>
          );
        })}
        {!hitl && !failed && sess.stages?.[3] === "progress" && (
          <div className="tool-row" data-kind="thought">
            <span /><span className="ic">…</span>
            <span className="nm" style={{ color: "var(--acc-progress)" }}>
              <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 3, background: "var(--acc-progress)", marginRight: 6, animation: "pulse 1.6s infinite" }} />
              builder thinking…
            </span>
            <span />
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────── HITL input ───────── */

export function HitlInput({ sess, stageName = "run", taskId, questions, onSubmit }) {
  const initialAnswers = () => Object.fromEntries(
    (questions || [])
      .map((q) => {
        const value = q.value ?? q.selected;
        if (value === undefined || value === null || String(value).trim() === "") return null;
        return [q.id, Array.isArray(value) ? value.join(",") : String(value)];
      })
      .filter(Boolean),
  );
  const [answers, setAnswers] = useState(initialAnswers);
  useEffect(() => {
    setAnswers(initialAnswers());
  }, [sess.id, stageName, taskId, questions.map((q) => `${q.id}:${q.value ?? q.selected ?? ""}`).join("|")]);
  const setA = (id, v) => setAnswers(a => ({ ...a, [id]: v }));

  return (
    <div className="hitl">
      <div className="hitl-banner">
        <span style={{ width: 6, height: 6, borderRadius: 3, background: "var(--acc-await)" }} />
        <span>{stageName} está bloqueado esperando tu input · round {sess.hitlRound || 1}/{sess.hitlMax || 3} · {questions.length} preguntas tipadas</span>
      </div>
      {questions.map(q => <QuestionCard key={q.id} q={q} value={answers[q.id]} onChange={(v) => setA(q.id, v)} />)}
      <div className="hitl-actions">
        <button className="btn ghost sm">Saltar (usar defaults)</button>
        <button className="btn primary sm" onClick={() => onSubmit && onSubmit(answers)}>Submit answers & resume &nbsp;<span style={{ color: "rgba(255,255,255,.5)" }}>⌘⏎</span></button>
      </div>
    </div>
  );
}

export function QuestionCard({ q, value, onChange }) {
  return (
    <div className="q-card">
      <div className="qhdr">
        <span className="qid">{q.id} · {q.kind}</span>
        <span style={{ color: "var(--fg-3)", fontSize: 11 }}>required</span>
      </div>
      <div className="qprompt">{q.prompt}</div>
      {q.context && <div className="qctx">{q.context}</div>}
      {q.kind === "free" && (
        <textarea
          placeholder="Tu respuesta…"
          value={value ?? q.value ?? ""}
          onChange={e => onChange(e.target.value)}
        />
      )}
      {q.kind === "choice" && (
        <div className="q-opts">
          {q.options.map(o => {
            const cur = value ?? q.selected;
            return (
              <div key={o.v} className="q-opt" data-on={cur === o.v ? "true" : "false"} onClick={() => onChange(o.v)}>
                <div className="radio" />
                <div>
                  <div className="opt-label">{o.label}</div>
                  {o.hint && <div className="opt-hint">{o.hint}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {q.kind === "confirm" && (
        <div className="q-confirm">
          <button data-v="yes" data-on={String(value ?? q.selected ?? q.value) === "yes" || String(value ?? q.selected ?? q.value) === "true" ? "true" : "false"} onClick={() => onChange("yes")}>✓ Sí</button>
          <button data-v="no" data-on={String(value ?? q.selected ?? q.value) === "no" || String(value ?? q.selected ?? q.value) === "false" ? "true" : "false"} onClick={() => onChange("no")}>✗ No</button>
        </div>
      )}
      {q.kind === "ranking" && (
        <RankingInput items={q.items} value={value} onChange={onChange} />
      )}
    </div>
  );
}

export function RankingInput({ items, value, onChange }) {
  const initial = value || items.map(i => i.v);
  const [order, setOrder] = useState(initial);
  const sorted = order.map(v => items.find(i => i.v === v));
  const move = (idx, dir) => {
    const next = [...order];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    setOrder(next);
    onChange && onChange(next);
  };
  return (
    <div className="q-rank">
      {sorted.map((it, i) => (
        <div key={it.v} className="q-rank-item">
          <span className="grip">⋮⋮</span>
          <span className="idx">{i + 1}.</span>
          <span style={{ flex: 1 }}>{it.label}</span>
          <button className="btn ghost sm" onClick={() => move(i, -1)}>↑</button>
          <button className="btn ghost sm" onClick={() => move(i, +1)}>↓</button>
        </div>
      ))}
    </div>
  );
}

/* ───────── Learn ───────── */

export function LearnStage({ sess, detail }) {
  const groups = {
    decision: { label: "Decisiones", items: [] },
    pattern: { label: "Patrones", items: [] },
    error: { label: "Errores", items: [] },
    followup: { label: "Follow-ups", items: [] },
  };
  (detail.learn || []).forEach(it => groups[it.cat].items.push(it));
  const structuredDecisions = (detail.decisions || []).filter(d => d.reversibility === "hard" || d.reversibility === "permanent");
  return (
    <div>
      <div className="stage-title-row">
        <div>
          <h2>Learn</h2>
          <div className="sub">Lo que el sistema saca de esta sesión, listo para subir a la wiki.</div>
        </div>
        <Chip state="done">✓ {(detail.learn || []).length} learnings extraídos</Chip>
      </div>
      {structuredDecisions.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="section-label" style={{ padding: "6px 0 8px" }}>
            Decisiones críticas · hard / permanent ({structuredDecisions.length})
          </div>
          {structuredDecisions.map(d => <DecisionCard key={d.id} d={d} />)}
        </div>
      )}
      {Object.entries(groups).map(([cat, g]) => g.items.length > 0 && (
        <div key={cat}>
          <div className="section-label" style={{ padding: "6px 0 8px" }}>{g.label}</div>
          <div className="learn-grid">
            {g.items.map((it, i) => (
              <div key={i} className="learn-card">
                <div className="lh">
                  <span className="know-cat" data-c={cat}>{cat}</span>
                </div>
                <div className="lt">{it.text}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ───────── Evolve ───────── */

export function EvolveStage({ sess, detail, onApply }) {
  const [agents, setAgents] = useState((detail.evolve?.agentsDiff || []).reduce((acc, s) => (acc[s.id] = s.state || "pending", acc), {}));
  const [wiki, setWiki] = useState((detail.evolve?.wikiDiff || []).reduce((acc, s) => (acc[s.id] = s.state || "pending", acc), {}));
  const [applying, setApplying] = useState(false);

  const renderSect = (sect, state, setState, isWiki = false) => (
    <div key={sect.id} className="evolve-section">
      <div className="evolve-section-hdr">
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sect.title}</span>
          {isWiki && (
            <span style={{
              display: "inline-block",
              padding: "1px 5px",
              borderRadius: 3,
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              background: "color-mix(in oklch, var(--acc-await) 15%, transparent)",
              color: "var(--acc-await)",
              border: "1px solid color-mix(in oklch, var(--acc-await) 30%, transparent)",
              flexShrink: 0,
            }}>
              auto
            </span>
          )}
        </div>
        <div className="acts">
          <button className="evolve-act" data-on={state[sect.id] === "apply" ? "apply" : ""} onClick={() => setState(s => ({ ...s, [sect.id]: "apply" }))}>apply</button>
          <button className="evolve-act" data-on={state[sect.id] === "reject" ? "reject" : ""} onClick={() => setState(s => ({ ...s, [sect.id]: "reject" }))}>reject</button>
        </div>
      </div>
      <div className="diff">
        {sect.lines.map((l, i) => (
          <div key={i} className="diff-line" data-k={l.k}>
            <span className="ln">{l.k === "hunk" ? "" : i}</span>
            <span>{l.k === "add" ? "+ " : l.k === "rem" ? "- " : "  "}{l.t.replace(/^[-+]/, "")}</span>
          </div>
        ))}
      </div>
    </div>
  );

  const allDecisions = { ...agents, ...wiki };
  const applyCount = Object.values(allDecisions).filter(s => s === "apply").length;
  const rejectCount = Object.values(allDecisions).filter(s => s === "reject").length;
  const pendingCount = (detail.evolve?.agentsDiff || []).length + (detail.evolve?.wikiDiff || []).length - applyCount - rejectCount;

  const handleApply = async () => {
    if (!onApply || applying || applyCount === 0) return;
    setApplying(true);
    await onApply(allDecisions);
    setApplying(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="stage-title-row">
        <div>
          <h2>Evolve</h2>
          <div className="sub">Diff propuesto a la memoria viva del proyecto. Aplicá o rechazá por sección.</div>
        </div>
        <div className="row gap-6">
          <Chip state="done">{applyCount} apply</Chip>
          <Chip state="failed">{rejectCount} reject</Chip>
          <Chip state="await">{pendingCount} pending</Chip>
        </div>
      </div>
      <div className="evolve-grid" style={{ flex: 1, minHeight: 0 }}>
        <div className="evolve-panel">
          <div className="card">
            <div className="card-hdr">
              <span className="title">docs / wiki</span>
              <span className="dim mono">{(detail.evolve?.agentsDiff || []).length} sections</span>
            </div>
            <div className="card-body">
              {(detail.evolve?.agentsDiff || []).length === 0 && (
                <div className="dim" style={{ fontSize: 12, padding: "8px 0" }}>Sin actualizaciones propuestas.</div>
              )}
              {(detail.evolve?.agentsDiff || []).map(s => renderSect(s, agents, setAgents, false))}
            </div>
          </div>
        </div>
        <div className="evolve-panel">
          <div className="card">
            <div className="card-hdr">
              <span className="title">wiki/decisions</span>
              <span className="dim mono">{(detail.evolve?.wikiDiff || []).length} auto-generadas</span>
            </div>
            <div className="card-body">
              {(detail.evolve?.wikiDiff || []).length === 0 && (
                <div className="dim" style={{ fontSize: 12, padding: "8px 0" }}>Sin decisiones críticas para documentar.</div>
              )}
              {(detail.evolve?.wikiDiff || []).map(s => renderSect(s, wiki, setWiki, true))}
            </div>
          </div>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <button className="btn ghost" onClick={() => {
          const all = {};
          [...(detail.evolve?.agentsDiff || []), ...(detail.evolve?.wikiDiff || [])].forEach(s => { all[s.id] = "reject"; });
          setAgents(all); setWiki({});
        }}>Reject all</button>
        <button className="btn primary" disabled={applying || applyCount === 0} onClick={handleApply}>
          {applying ? "Applying…" : `Apply ${applyCount} change${applyCount === 1 ? "" : "s"}`}
          {!applying && <span style={{ color: "rgba(255,255,255,.5)" }}>&nbsp;⌘⏎</span>}
        </button>
      </div>
    </div>
  );
}

/* ───────── Composer ───────── */

export function Composer({ placeholder }) {
  return (
    <div className="composer-wrapper">
      <div className="composer">
        <textarea placeholder={placeholder} className="composer-input" rows={1}></textarea>
        <div className="composer-footer">
          <div className="composer-tools">
            <button className="composer-tool active"><span className="ic">🤖</span> Gemini 3.1 Pro (High) <span style={{ opacity: 0.5 }}>⌄</span></button>
            <button className="composer-tool"><span className="ic">🔗</span> Link issue</button>
            <button className="composer-icon-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg></button>
          </div>
          <div className="composer-actions">
            <button className="composer-icon-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg></button>
            <button className="composer-icon-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg></button>
            <button className="composer-submit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg></button>
          </div>
        </div>
      </div>
    </div>
  );
}
