// @ts-nocheck
"use client";
import React, { useState, useEffect, useRef, useMemo, Fragment } from 'react';
import { STAGE_NAMES } from '@slad/shared';
import { StageDots, Chip, Tag, Breadcrumb, JsonTree, ProviderChip, HarnessSeg, STAGE_GLYPHS, fmtUsd, fmtTokens } from './components';

// SLAD OS — Artifact / Action panel (right)



export function ArtifactPanel({ sess, detail: detailProp, artifacts = {}, tweaks, setTweak }) {
  const [tab, setTab] = useState("json"); // json | friendly | files

  const detail = sess ? (detailProp || {}) : {};
  const stageIdx = sess?.activeStage;
  const isRun = stageIdx === 3;
  const tabs = isRun
    ? [{ k: "files", l: "Files" }, { k: "verify", l: "Verify" }, { k: "json", l: "JSON" }]
    : [{ k: "json", l: "JSON" }, { k: "friendly", l: "Friendly" }];

  // Ensure tab valid
  React.useEffect(() => {
    if (sess && !tabs.find(t => t.k === tab)) setTab(tabs[0].k);
  }, [sess?.id, tabs, tab]);

  if (!sess) {
    return (
      <div className="panel">
        <div className="panel-hdr">
          <span style={{ color: "var(--fg-3)", padding: "0 6px" }}>Artifact</span>
        </div>
        <div className="panel-body">
          <div style={{ padding: 20, fontSize: 12.5, color: "var(--fg-3)", lineHeight: 1.6 }}>
            Iniciá una sesión para inspeccionar artefactos JSON, archivos modificados y comandos de verificación.
          </div>
        </div>
        <ArtifactFooter tweaks={tweaks} setTweak={setTweak} sess={null} />
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-hdr" style={{ padding: 0 }}>
        <div className="art-tabs">
          {tabs.map(t => (
            <button key={t.k} className="art-tab" data-on={tab === t.k ? "true" : "false"} onClick={() => setTab(t.k)}>{t.l}</button>
          ))}
        </div>
        <button className="ico-btn" style={{ marginRight: 4 }} title="Copiar">⧉</button>
      </div>
      <div className="panel-body">
        {tab === "json" && <JsonView sess={sess} detail={detail} artifacts={artifacts} />}
        {tab === "friendly" && <FriendlyView sess={sess} detail={detail} artifacts={artifacts} />}
        {tab === "files" && isRun && <FilesView sess={sess} detail={detail} />}
        {tab === "verify" && isRun && <VerifyView sess={sess} detail={detail} />}
      </div>
      <ArtifactFooter tweaks={tweaks} setTweak={setTweak} sess={sess} />
    </div>
  );
}

export function JsonView({ sess, detail, artifacts = {} }) {
  // Build an artifact for the current stage
  const stage = STAGE_NAMES[sess.activeStage];
  let data;
  const persisted = artifacts[`${sess.id}:${stage}`];
  if (persisted) {
    data = persisted;
  } else {
    data = detail?.[stage] || {};
  }
  if (!data || Object.keys(data).length === 0) {
    return (
      <div className="friendly">
        <div className="fr-block">
          <div className="fr-block-hdr"><span>Artifact</span><span>{stage}</span></div>
          <div className="fr-block-body"><p className="dim">No hay artifact persistido para este stage.</p></div>
        </div>
      </div>
    );
  }
  return (
    <div>
      <div style={{ padding: "10px 14px 4px", fontSize: 11, color: "var(--fg-3)", display: "flex", justifyContent: "space-between" }}>
        <span><span className="mono" style={{ color: "var(--fg-2)" }}>{data.schema || `slad.${stage}.v1`}</span> · stage <span className="mono">{stage}</span></span>
        {data.cache?.hit ? <Tag v="cache">cache hit · saved ${data.cache.saved_usd?.toFixed?.(2) ?? "0.00"}</Tag> : <Tag v="fresh">persisted</Tag>}
      </div>
      <div className="json-view">
        <JsonTree data={data} />
      </div>
    </div>
  );
}

export function FriendlyView({ sess, detail, artifacts = {} }) {
  const stage = STAGE_NAMES[sess.activeStage];
  const persisted = artifacts[`${sess.id}:${stage}`];
  if (persisted && stage !== "plan") {
    return (
      <div className="friendly">
        <div className="fr-block">
          <div className="fr-block-hdr"><span>{stage}</span><span>persisted</span></div>
          <div className="fr-block-body">
            <p>{String(persisted.summary || persisted.reframing || persisted.title || persisted.status || "Artifact persistido")}</p>
          </div>
        </div>
      </div>
    );
  }
  if (stage === "plan") {
    const p = persisted || detail?.plan || {};
    if (!p || Object.keys(p).length === 0) {
      return (
        <div className="friendly">
          <div className="fr-block">
            <div className="fr-block-hdr"><span>Plan</span></div>
            <div className="fr-block-body"><p className="dim">No hay artifact de plan persistido.</p></div>
          </div>
        </div>
      );
    }
    return (
      <div className="friendly">
        <div className="fr-block">
          <div className="fr-block-hdr"><span>Goal</span><span>schema {p.schema}</span></div>
          <div className="fr-block-body"><p>{p.goal || p.summary || p.snapshot || "Plan persistido"}</p></div>
        </div>
        <div className="fr-block">
          <div className="fr-block-hdr"><span>Constraints</span></div>
          <div className="fr-block-body">
            <div className="kv"><span className="k">stack</span><span className="v mono">{(p.constraints?.stack || []).join(", ")}</span></div>
            <div className="kv"><span className="k">packaging</span><span className="v mono">{p.constraints?.packaging}</span></div>
            <div className="kv"><span className="k">ipc</span><span className="v mono">{p.constraints?.ipc}</span></div>
          </div>
        </div>
        <div className="fr-block">
          <div className="fr-block-hdr"><span>Tasks</span><span>{p.tasks?.length || 0} total</span></div>
          <div className="fr-block-body">
            <ul>
              {(p.tasks || []).map(t => (
                <li key={t.id}><span className="mono dim">{t.id}</span> · deps: <span className="mono">{(t.deps || t.dependsOn || []).join(",") || "—"}</span></li>
              ))}
            </ul>
          </div>
        </div>
        <div className="fr-block">
          <div className="fr-block-hdr"><span>Estimated</span></div>
          <div className="fr-block-body">
            <div className="kv"><span className="k">tokens</span><span className="v">{fmtTokens(p.estimated?.tokens_total || 0)}</span></div>
            <div className="kv"><span className="k">cost</span><span className="v">{fmtUsd(p.estimated?.cost_usd || 0)}</span></div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="friendly">
      <div className="fr-block">
        <div className="fr-block-hdr"><span>Artifact</span></div>
        <div className="fr-block-body"><p className="dim">Sin friendly view custom para este stage — usá el JSON tab.</p></div>
      </div>
    </div>
  );
}

export function FilesView({ sess, detail }) {
  const [active, setActive] = useState(detail.activeFile || (detail.files && detail.files[0]?.path));
  const totalAdd = (detail.files || []).reduce((a, f) => a + f.add, 0);
  const totalRem = (detail.files || []).reduce((a, f) => a + f.rem, 0);
  return (
    <div>
      <div style={{ padding: "10px 14px 4px", fontSize: 11, color: "var(--fg-3)", display: "flex", justifyContent: "space-between" }}>
        <span>{(detail.files || []).length} files · <span className="mono" style={{ color: "var(--acc-done)" }}>+{totalAdd}</span> <span className="mono" style={{ color: "var(--acc-failed)" }}>−{totalRem}</span></span>
        <Tag v="fresh">live</Tag>
      </div>
      <div className="files-list">
        {(detail.files || []).map(f => {
          const parts = f.path.split("/");
          const fname = parts.pop();
          const dir = parts.join("/") + (parts.length ? "/" : "");
          return (
            <div key={f.path} className="file-row" data-active={active === f.path ? "true" : "false"} onClick={() => setActive(f.path)}>
              <span className="fname">
                <span className="dir">{dir}</span>{fname}
                {f.deleted && <span style={{ color: "var(--acc-failed)", marginLeft: 6 }}>(deleted)</span>}
              </span>
              <span className="stats">
                <span className="a">+{f.add}</span>
                <span className="r">−{f.rem}</span>
              </span>
            </div>
          );
        })}
      </div>
      {active && detail.activeFileDiff && active === detail.activeFile && (
        <div style={{ borderTop: "1px solid var(--border-1)", marginTop: 8, paddingTop: 6 }}>
          <div style={{ padding: "6px 14px", fontSize: 11, color: "var(--fg-3)" }} className="mono">{active}</div>
          <div className="diff">
            {detail.activeFileDiff.map((l, i) => (
              <div key={i} className="diff-line" data-k={l.k}>
                <span className="ln">{l.k === "hunk" ? "" : i}</span>
                <span>{l.k === "add" ? "+ " : l.k === "rem" ? "- " : "  "}{l.t.replace(/^[-+]/, "")}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function VerifyView({ sess, detail }) {
  return (
    <div style={{ padding: "10px 12px" }}>
      <div style={{ fontSize: 11, color: "var(--fg-3)", marginBottom: 6 }}>
        verification[].command — primer-class. T{(detail.runActiveTask || "T?").slice(1)} done = todos en ✓.
      </div>
      <div className="verif">
        {(detail.verify || []).map((v, i) => (
          <div key={i} className="verif-row" data-s={v.state}>
            <span className="ic">
              {v.state === "done" ? "✓" : v.state === "failed" ? "✗" : v.state === "running" ? "◐" : "·"}
            </span>
            <span className="cmd">$ {v.cmd}</span>
            <span className="dur">{v.dur}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ArtifactFooter({ tweaks, setTweak, sess }) {
  const provider = sess?.provider || { vendor: "anthropic", model: "claude-opus-4.6" };
  return (
    <div className="panel-ftr">
      <div className="art-ftr-row">
        <span className="lbl">Provider</span>
        <ProviderChip vendor={provider.vendor} model={provider.model} />
      </div>
      <div className="art-ftr-row">
        <span className="lbl">Tokens / cost</span>
        <span className="val">{sess ? fmtTokens(sess.tokens) : "—"} · <span style={{ color: "var(--fg-2)" }}>{sess ? fmtUsd(sess.costUsd) : "$0.00"}</span></span>
      </div>
      <div className="art-ftr-row">
        <span className="lbl">Cache</span>
        <span className="val mono" style={{ fontSize: 11 }}>
          {sess ? <><span style={{ color: "var(--acc-cache)" }}>{sess.cacheHits} hits</span> <span style={{ color: "var(--fg-3)" }}>· {sess.cacheMisses} miss</span></> : "—"}
        </span>
      </div>
      <div className="art-ftr-row">
        <span className="lbl">Harness</span>
        <HarnessSeg value={tweaks.harness} onChange={v => setTweak("harness", v)} />
      </div>
    </div>
  );
}
