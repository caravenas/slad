// @ts-nocheck
"use client";
import React, { useState, useEffect, useRef, useMemo, Fragment } from 'react';
import { STAGE_NAMES } from '@slad/shared';

// SLAD OS — shared UI primitives



export const STAGE_GLYPHS = {
  done: "✓",
  progress: "◐",
  pending: "·",
  await: "⏸",
  failed: "✗",
};

export function StageDots({ stages, activeIdx }) {
  return (
    <div className="pipe" title={stages.join(" → ")}>
      {stages.map((s, i) => (
        <span key={i} data-s={s} data-active={i === activeIdx ? "true" : "false"} />
      ))}
    </div>
  );
}

export function Chip({ state, dot = true, children, sq = false }) {
  return (
    <span className={"chip" + (sq ? " sq" : "")} data-state={state}>
      {dot ? <span className="chip-dot" /> : null}
      {children}
    </span>
  );
}

export function Tag({ v, children }) {
  return <span className="tag" data-v={v}>{children}</span>;
}

export function Breadcrumb({ stages, activeIdx, onPick }) {
  return (
    <div className="breadcrumb">
      {stages.map((s, i) => {
        const name = STAGE_NAMES[i];
        return (
          <React.Fragment key={i}>
            <button
              className="bc-step"
              data-active={i === activeIdx ? "true" : "false"}
              data-s={s}
              onClick={() => onPick && onPick(i)}
            >
              <span className="glyph">{STAGE_GLYPHS[s] || "·"}</span>
              <span>{name}</span>
            </button>
            {i < stages.length - 1 ? <span className="bc-sep">›</span> : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// Simple recursive JSON tree.
export function JsonTree({ data, depth = 0 }) {
  if (data === null) return <span className="jn-null">null</span>;
  if (typeof data === "string") return <span className="js">"{data}"</span>;
  if (typeof data === "number") return <span className="jn">{String(data)}</span>;
  if (typeof data === "boolean") return <span className="jb">{String(data)}</span>;

  const isArr = Array.isArray(data);
  const entries = isArr ? data.map((v, i) => [i, v]) : Object.entries(data);
  const [open, setOpen] = useState(depth < 2);
  const indent = { paddingLeft: depth === 0 ? 0 : 14 };

  if (!open) {
    return (
      <span>
        <button
          className="toggle"
          onClick={() => setOpen(true)}
          style={{
            background: "transparent", border: 0, color: "var(--fg-3)",
            cursor: "default", padding: "0 4px 0 0", font: "inherit",
          }}
        >▶</button>
        <span className="jp">{isArr ? "[" : "{"}</span>
        <span className="jc"> {entries.length} {isArr ? "items" : "keys"} </span>
        <span className="jp">{isArr ? "]" : "}"}</span>
      </span>
    );
  }

  return (
    <span>
      <button
        className="toggle"
        onClick={() => setOpen(false)}
        style={{
          background: "transparent", border: 0, color: "var(--fg-3)",
          cursor: "default", padding: "0 4px 0 0", font: "inherit",
        }}
      >▼</button>
      <span className="jp">{isArr ? "[" : "{"}</span>
      <div style={indent}>
        {entries.map(([k, v], i) => (
          <div key={i} className="json-tree-row">
            <span className="jk">{isArr ? "" : `"${k}"`}</span>
            {!isArr ? <span className="jp">:&nbsp;</span> : null}
            <JsonTree data={v} depth={depth + 1} />
            {i < entries.length - 1 ? <span className="jp">,</span> : null}
          </div>
        ))}
      </div>
      <span className="jp">{isArr ? "]" : "}"}</span>
    </span>
  );
}

export function ProviderChip({ vendor, model, onClick }) {
  return (
    <button className="provider-chip" onClick={onClick}>
      <span className="dot" />
      <span style={{ color: "var(--fg-3)" }}>{vendor}</span>
      <span style={{ color: "var(--fg-4)" }}>·</span>
      <span>{model}</span>
    </button>
  );
}

export function HarnessSeg({ value, onChange }) {
  const opts = ["off", "on", "strict"];
  return (
    <div className="harness-seg">
      {opts.map(o => (
        <button key={o} data-on={value === o ? "true" : "false"} onClick={() => onChange(o)}>{o}</button>
      ))}
    </div>
  );
}

export function fmtUsd(n) {
  return "$" + n.toFixed(2);
}
export function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

