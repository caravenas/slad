// @ts-nocheck
"use client";
import React, { useEffect, useState } from "react";

const STAGES = ["explore", "snapshot", "plan", "run", "learn", "evolve"];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function Field({ label, children }) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function TextInput(props) {
  return <input className="settings-input" {...props} />;
}

function TextArea(props) {
  return <textarea className="settings-textarea" {...props} />;
}

export function SettingsModal({ open, data, onClose, onSave }) {
  const [tab, setTab] = useState("profiles");
  const [draft, setDraft] = useState(null);
  const [activeProfileId, setActiveProfileId] = useState("");

  useEffect(() => {
    if (!data?.effective) return;
    setDraft(clone(data.effective));
    setActiveProfileId(data.effective.activeProfileId || data.effective.profiles?.[0]?.id || "");
  }, [data]);

  if (!open) return null;
  if (!draft) {
    return (
      <div className="modal-backdrop" onMouseDown={onClose}>
        <div className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
          <div className="settings-empty">Loading settings...</div>
        </div>
      </div>
    );
  }

  const activeProfile = draft.profiles.find((profile) => profile.id === activeProfileId) || draft.profiles[0];
  const updateProfile = (id, patch) => {
    setDraft((cur) => ({
      ...cur,
      profiles: cur.profiles.map((profile) => profile.id === id ? { ...profile, ...patch } : profile),
    }));
  };
  const updateNested = (section, patch) => setDraft((cur) => ({ ...cur, [section]: { ...cur[section], ...patch } }));
  const save = () => onSave({ ...draft, activeProfileId });

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <div>
            <div className="settings-title">Settings</div>
            <div className="settings-subtitle">Global profile selection + project configuration</div>
          </div>
          <button className="ico-btn" onClick={onClose}>x</button>
        </div>

        <div className="settings-body">
          <div className="settings-tabs">
            {["profiles", "prompts", "providers", "harness", "paths"].map((item) => (
              <button key={item} data-on={tab === item ? "true" : "false"} onClick={() => setTab(item)}>
                {item}
              </button>
            ))}
          </div>

          <div className="settings-content">
            {tab === "profiles" && (
              <div className="settings-grid two">
                <div className="settings-card">
                  <div className="settings-card-title">Active profile</div>
                  <Field label="Default profile">
                    <select className="settings-input" value={activeProfileId} onChange={(e) => setActiveProfileId(e.target.value)}>
                      {draft.profiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>{profile.label}</option>
                      ))}
                    </select>
                  </Field>
                  <div className="settings-note">This selection is saved globally and used for all sessions unless a run explicitly overrides it.</div>
                </div>

                <div className="settings-card">
                  <div className="settings-card-title">Profile editor</div>
                  {activeProfile && (
                    <>
                      <Field label="Label">
                        <TextInput value={activeProfile.label} onChange={(e) => updateProfile(activeProfile.id, { label: e.target.value })} />
                      </Field>
                      <div className="settings-row">
                        <Field label="Agent">
                          <select className="settings-input" value={activeProfile.agent || ""} onChange={(e) => updateProfile(activeProfile.id, { agent: e.target.value || undefined })}>
                            <option value="">none</option>
                            <option value="codex">codex</option>
                            <option value="gemini">gemini</option>
                            <option value="claude">claude</option>
                            <option value="agent">agent</option>
                          </select>
                        </Field>
                        <Field label="Model">
                          <TextInput value={activeProfile.model || ""} onChange={(e) => updateProfile(activeProfile.id, { model: e.target.value || undefined })} />
                        </Field>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {tab === "prompts" && activeProfile && (
              <div className="settings-grid two">
                <div className="settings-card">
                  <div className="settings-card-title">Built-in prompts</div>
                  {STAGES.map((stage) => (
                    <details key={stage} className="settings-details">
                      <summary>{stage}</summary>
                      <pre>{data.builtInPrompts?.[stage] || ""}</pre>
                    </details>
                  ))}
                </div>
                <div className="settings-card">
                  <div className="settings-card-title">Profile guidance</div>
                  {STAGES.map((stage) => (
                    <Field key={stage} label={stage}>
                      <TextArea
                        rows={3}
                        value={activeProfile.promptGuidance?.[stage] || ""}
                        onChange={(e) => updateProfile(activeProfile.id, {
                          promptGuidance: {
                            ...(activeProfile.promptGuidance || {}),
                            [stage]: e.target.value,
                          },
                        })}
                      />
                    </Field>
                  ))}
                </div>
              </div>
            )}

            {tab === "providers" && (
              <div className="settings-grid two">
                <div className="settings-card">
                  <div className="settings-card-title">Provider defaults</div>
                  <Field label="Default provider">
                    <select className="settings-input" value={draft.providers.defaultProvider} onChange={(e) => updateNested("providers", { defaultProvider: e.target.value })}>
                      <option value="anthropic">anthropic</option>
                      <option value="openai">openai</option>
                      <option value="gemini">gemini</option>
                      <option value="cli">cli</option>
                    </select>
                  </Field>
                  {["anthropic", "openai", "gemini", "cli"].map((provider) => (
                    <Field key={provider} label={`${provider} model`}>
                      <TextInput
                        value={draft.providers.models?.[provider] || ""}
                        onChange={(e) => updateNested("providers", {
                          models: { ...(draft.providers.models || {}), [provider]: e.target.value },
                        })}
                      />
                    </Field>
                  ))}
                </div>
                <div className="settings-card">
                  <div className="settings-card-title">API key env refs</div>
                  {["anthropic", "openai", "gemini"].map((provider) => {
                    const status = data.validation?.apiKeys?.find((item) => item.provider === provider);
                    return (
                      <Field key={provider} label={`${provider} env`}>
                        <div className="settings-inline">
                          <TextInput
                            value={draft.providers.apiKeyEnv?.[provider] || ""}
                            onChange={(e) => updateNested("providers", {
                              apiKeyEnv: { ...(draft.providers.apiKeyEnv || {}), [provider]: e.target.value },
                            })}
                          />
                          <span className={status?.present ? "settings-ok" : "settings-warn"}>
                            {status?.present ? "present" : "missing"}
                          </span>
                        </div>
                      </Field>
                    );
                  })}
                </div>
              </div>
            )}

            {tab === "harness" && (
              <div className="settings-grid two">
                <div className="settings-card">
                  <div className="settings-card-title">Harness policy</div>
                  <div className="settings-row">
                    <Field label="Mode">
                      <select className="settings-input" value={draft.harness.mode} onChange={(e) => updateNested("harness", { mode: e.target.value })}>
                        <option value="off">off</option>
                        <option value="on">on</option>
                        <option value="strict">strict</option>
                      </select>
                    </Field>
                    <Field label="Max permission">
                      <select className="settings-input" value={draft.harness.maxPermission} onChange={(e) => updateNested("harness", { maxPermission: e.target.value })}>
                        <option value="read">read</option>
                        <option value="workspace">workspace</option>
                        <option value="full">full</option>
                      </select>
                    </Field>
                  </div>
                  <Field label="Allowed write paths">
                    <TextArea rows={4} value={(draft.harness.allowedWritePaths || []).join("\n")} onChange={(e) => updateNested("harness", { allowedWritePaths: e.target.value.split(/\n/).map((v) => v.trim()).filter(Boolean) })} />
                  </Field>
                  <Field label="Always approve patterns">
                    <TextArea rows={5} value={(draft.harness.alwaysApprove || []).join("\n")} onChange={(e) => updateNested("harness", { alwaysApprove: e.target.value.split(/\n/).map((v) => v.trim()).filter(Boolean) })} />
                  </Field>
                </div>
                <div className="settings-card">
                  <div className="settings-card-title">Audit + hooks</div>
                  <label className="settings-check">
                    <input type="checkbox" checked={draft.harness.auditLog} onChange={(e) => updateNested("harness", { auditLog: e.target.checked })} />
                    Audit log enabled
                  </label>
                  <Field label="Audit log path">
                    <TextInput value={draft.harness.auditLogPath || ""} onChange={(e) => updateNested("harness", { auditLogPath: e.target.value })} />
                  </Field>
                  <Field label="Pre-task hooks">
                    <TextArea rows={3} value={(draft.harness.preTaskHooks || []).join("\n")} onChange={(e) => updateNested("harness", { preTaskHooks: e.target.value.split(/\n/).map((v) => v.trim()).filter(Boolean) })} />
                  </Field>
                  <Field label="Post-task hooks">
                    <TextArea rows={3} value={(draft.harness.postTaskHooks || []).join("\n")} onChange={(e) => updateNested("harness", { postTaskHooks: e.target.value.split(/\n/).map((v) => v.trim()).filter(Boolean) })} />
                  </Field>
                </div>
              </div>
            )}

            {tab === "paths" && (
              <div className="settings-grid two">
                <div className="settings-card">
                  <div className="settings-card-title">Paths</div>
                  <Field label="Docs path">
                    <TextInput value={draft.paths.docsPath || ""} onChange={(e) => updateNested("paths", { docsPath: e.target.value })} />
                  </Field>
                  <Field label="Wiki path">
                    <TextInput value={draft.paths.wikiPath || ""} onChange={(e) => updateNested("paths", { wikiPath: e.target.value || undefined })} />
                  </Field>
                  <Field label="Active workspace">
                    <TextInput value={draft.paths.activeWorkspace || ""} onChange={(e) => updateNested("paths", { activeWorkspace: e.target.value || undefined })} />
                  </Field>
                </div>
                <div className="settings-card">
                  <div className="settings-card-title">Runtime</div>
                  <Field label="API timeout ms">
                    <TextInput type="number" value={draft.runtime.apiTimeoutMs || ""} onChange={(e) => updateNested("runtime", { apiTimeoutMs: e.target.value ? Number(e.target.value) : undefined })} />
                  </Field>
                  <Field label="CLI timeout ms">
                    <TextInput type="number" value={draft.runtime.cliTimeoutMs || ""} onChange={(e) => updateNested("runtime", { cliTimeoutMs: e.target.value ? Number(e.target.value) : undefined })} />
                  </Field>
                  <label className="settings-check">
                    <input type="checkbox" checked={draft.runtime.cliInheritApiKeys} onChange={(e) => updateNested("runtime", { cliInheritApiKeys: e.target.checked })} />
                    CLI inherits API key env vars
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="settings-footer">
          <div className="settings-warning">{data.validation?.warnings?.join(" ")}</div>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>Save settings</button>
        </div>
      </div>
    </div>
  );
}
