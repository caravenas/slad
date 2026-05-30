// @ts-nocheck
"use client";
import React, { useState, useEffect, useRef, useMemo, Fragment } from 'react';
import { STAGE_NAMES } from '@slad/shared';
import { StageDots, Chip, Tag, Breadcrumb, JsonTree, ProviderChip, HarnessSeg, STAGE_GLYPHS, fmtUsd, fmtTokens } from './components';

// SLAD OS — Sidebar (Sessions + Knowledge toggle)



export function Sidebar({
  sessions,
  activeId,
  onPick,
  archivingIds = [],
  optimisticArchivedIds = [],
  onArchiveSession,
  mode,
  onMode,
  onNewSession,
  knowledge,
  telemetry,
}) {
  if (mode === "knowledge") {
    return <KnowledgeView knowledge={knowledge} onMode={onMode} />;
  }
  if (mode === "stats") {
    return <TelemetryView telemetry={telemetry} onMode={onMode} />;
  }
  return (
    <div className="panel">
      <div className="panel-hdr">
        <div className="seg">
          <button data-on={mode === "sessions"} onClick={() => onMode("sessions")}>Sessions</button>
          <button data-on={mode === "knowledge"} onClick={() => onMode("knowledge")}>Knowledge</button>
          <button data-on={mode === "stats"} onClick={() => onMode("stats")}>Stats</button>
        </div>
        <div style={{ flex: 1 }} />
        <button className="ico-btn" title="Nueva intención (⌘N)" onClick={onNewSession}>＋</button>
      </div>
      <div className="sess-search">
        <span style={{ color: "var(--fg-4)" }}>⌕</span>
        <input placeholder="Buscar sesiones…" />
        <span className="kbd">⌘K</span>
      </div>
      <div className="panel-body">
        <div className="section-label">Activas</div>
        <div className="sess-list">
          {sessions.filter(s => s.stages.some(x => x === "progress" || x === "await" || x === "failed")).map(s => (
            <SessionRow
              key={s.id}
              s={s}
              active={s.id === activeId}
              onClick={() => onPick(s.id)}
              archiving={archivingIds.includes(s.id)}
              archived={Boolean(s.archivedAt) || optimisticArchivedIds.includes(s.id)}
              onArchive={() => onArchiveSession?.(s.id)}
            />
          ))}
        </div>
        <div className="section-label">Recientes</div>
        <div className="sess-list">
          {sessions.filter(s => !s.stages.some(x => x === "progress" || x === "await" || x === "failed")).map(s => (
            <SessionRow
              key={s.id}
              s={s}
              active={s.id === activeId}
              onClick={() => onPick(s.id)}
              archiving={archivingIds.includes(s.id)}
              archived={Boolean(s.archivedAt) || optimisticArchivedIds.includes(s.id)}
              onArchive={() => onArchiveSession?.(s.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function SessionRow({ s, active, onClick, archiving = false, archived = false, onArchive }) {
  const stageIdx = s.activeStage;
  const stageName = STAGE_NAMES[stageIdx];
  const stageState = s.stages[stageIdx];
  let tag = stageName;
  if (s.runMode === "hitl") tag = "awaiting human";
  else if (stageState === "progress") tag = stageName + " · live";
  else if (stageState === "failed") tag = stageName + " · failed";
  else if (s.stages.every(x => x === "done")) tag = "done";
  const counts = (s.tasksTotal && s.activeStage >= 3)
    ? `${s.tasksDone}/${s.tasksTotal} tasks`
    : null;
  return (
    <div className="sess-item" data-active={active ? "true" : "false"} onClick={onClick}>
      <div className="intent">{s.intent}</div>
      <StageDots stages={s.stages} activeIdx={s.activeStage} />
      <div className="meta">
        <span className="stage-tag" data-s={stageState}>{tag}</span>
        <span>{counts ? counts + " · " : ""}{s.updatedAt}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8, gap: 8 }}>
        {archived && (
          <span className="stage-tag" data-s="done">Archivada</span>
        )}
        {(!archived || archiving) && (
          <button
            className="btn ghost sm"
            disabled={archiving || archived}
            onClick={(event) => {
              event.stopPropagation();
              onArchive?.();
            }}
          >
            {archiving ? "Archivando…" : "Archivar"}
          </button>
        )}
      </div>
    </div>
  );
}

function fmtDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

function StatBar({ label, count, total, color = "var(--primary)" }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="telemetry-bar-row">
      <span className="telemetry-bar-label">{label}</span>
      <div className="telemetry-bar-track">
        <div className="telemetry-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="telemetry-bar-count">{count}</span>
    </div>
  );
}

export function TelemetryView({ telemetry, onMode }) {
  const setMode = onMode ?? ((m) => { if (typeof window !== "undefined") (window as any).__sladSetMode?.(m); });
  const t = telemetry ?? { totalRuns: 0, byCommand: { ask: 0, work: 0, "work-debate": 0 }, byStatus: { completed: 0, partial: 0, failed: 0 }, debateRuns: 0, avgDebateConsensus: null, classifierShown: 0, classifierAccepted: 0, avgDurationMs: null };

  return (
    <div className="panel">
      <div className="panel-hdr">
        <div className="seg">
          <button data-on={false} onClick={() => setMode("sessions")}>Sessions</button>
          <button data-on={false} onClick={() => setMode("knowledge")}>Knowledge</button>
          <button data-on={true}>Stats</button>
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ color: "var(--fg-3)", fontSize: 11 }}>{t.totalRuns} runs</span>
      </div>
      <div className="panel-body">
        {t.totalRuns === 0 ? (
          <div className="telemetry-empty">
            <div className="telemetry-empty-icon">📊</div>
            <div className="telemetry-empty-text">
              Sin datos de telemetría todavía.<br />
              Corre <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>slad work "..."</code> para empezar a acumular stats.
            </div>
          </div>
        ) : (
          <div className="telemetry-view">
            <div>
              <div className="telemetry-section-label">Resumen</div>
              <div className="telemetry-card">
                <div className="telemetry-stat-row">
                  <span className="telemetry-stat-label">Total runs</span>
                  <span className="telemetry-stat-value">{t.totalRuns}</span>
                </div>
                <div className="telemetry-stat-row">
                  <span className="telemetry-stat-label">Duración promedio</span>
                  <span className="telemetry-stat-value">{fmtDuration(t.avgDurationMs)}</span>
                </div>
                <div className="telemetry-stat-row">
                  <span className="telemetry-stat-label">Debate runs</span>
                  <span className="telemetry-stat-value">{t.debateRuns}</span>
                </div>
                {t.avgDebateConsensus != null && (
                  <div className="telemetry-stat-row">
                    <span className="telemetry-stat-label">Consenso debate</span>
                    <span className="telemetry-stat-value">{Math.round(t.avgDebateConsensus * 100)}%</span>
                  </div>
                )}
              </div>
            </div>

            <div>
              <div className="telemetry-section-label">Por comando</div>
              <div className="telemetry-card">
                <StatBar label="ask" count={t.byCommand.ask} total={t.totalRuns} color="var(--fg-3)" />
                <StatBar label="work" count={t.byCommand.work} total={t.totalRuns} color="var(--primary)" />
                <StatBar label="debate" count={t.byCommand["work-debate"]} total={t.totalRuns} color="var(--acc-await)" />
              </div>
            </div>

            <div>
              <div className="telemetry-section-label">Por estado</div>
              <div className="telemetry-card">
                <StatBar label="completed" count={t.byStatus.completed} total={t.totalRuns} color="var(--acc-done)" />
                <StatBar label="partial" count={t.byStatus.partial} total={t.totalRuns} color="var(--acc-await)" />
                <StatBar label="failed" count={t.byStatus.failed} total={t.totalRuns} color="var(--acc-failed)" />
              </div>
            </div>

            {t.classifierShown > 0 && (
              <div>
                <div className="telemetry-section-label">Classifier</div>
                <div className="telemetry-card">
                  <div className="telemetry-stat-row">
                    <span className="telemetry-stat-label">Sugerencias</span>
                    <span className="telemetry-stat-value">{t.classifierShown}</span>
                  </div>
                  <div className="telemetry-stat-row">
                    <span className="telemetry-stat-label">Aceptadas</span>
                    <span className="telemetry-stat-value">
                      {t.classifierAccepted} ({t.classifierShown > 0 ? Math.round(t.classifierAccepted / t.classifierShown * 100) : 0}%)
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function KnowledgeView({ knowledge = [], onMode }) {
  const [filter, setFilter] = useState("all");
  const items = knowledge.filter(k => filter === "all" || k.cat === filter);
  const cats = [
    { v: "all", l: "All" },
    { v: "decision", l: "Decisions" },
    { v: "pattern", l: "Patterns" },
    { v: "error", l: "Errors" },
    { v: "followup", l: "Follow-ups" },
  ];
  const setMode = onMode ?? ((m) => { if (typeof window !== "undefined") (window as any).__sladSetMode?.(m); });
  return (
    <div className="panel">
      <div className="panel-hdr">
        <div className="seg">
          <button data-on={false} onClick={() => setMode("sessions")}>Sessions</button>
          <button data-on={true}>Knowledge</button>
          <button data-on={false} onClick={() => setMode("stats")}>Stats</button>
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ color: "var(--fg-3)", fontSize: 11 }}>{items.length} items</span>
      </div>
      <div className="sess-search">
        <span style={{ color: "var(--fg-4)" }}>⌕</span>
        <input placeholder="Buscar en knowledge…" />
        <span className="kbd">/</span>
      </div>
      <div className="know-filters">
        {cats.map(c => (
          <button key={c.v} className="know-filter" data-on={filter === c.v ? "true" : "false"} onClick={() => setFilter(c.v)}>{c.l}</button>
        ))}
      </div>
      <div className="panel-body">
        <div className="know-list">
          {items.map((k, i) => (
            <div key={i} className="know-item">
              <div className="know-hdr">
                <span className="know-cat" data-c={k.cat}>{k.cat}</span>
                <span>{k.proj}</span>
                <span style={{ color: "var(--fg-4)" }}>·</span>
                <span>{k.time}</span>
              </div>
              <div className="know-snippet">{k.text}</div>
              <div className="know-foot">
                <span className="link">↪ session {k.session}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
