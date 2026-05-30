import type { ChildProcess } from "node:child_process";
import { commandForMode, commandForStage, type SladPipelineStage, type SladRunMode } from "@slad/pipeline";
import { setActiveSession, spawnSladCli } from "./slad-server";

type LogStream = "stdout" | "stderr" | "system";
type JobStatus = "running" | "completed" | "failed" | "cancelled";

export type PipelineJob = {
  id: string;
  sessionId: string;
  stage: SladPipelineStage | SladRunMode;
  status: JobStatus;
  exitCode: number | null;
  logs: Array<{ stream: LogStream; line: string; at: string }>;
  listeners: Set<(event: JobEvent) => void>;
  child?: ChildProcess;
};

export type JobEvent =
  | { type: "log"; stream: LogStream; line: string; at: string }
  | { type: "status"; status: JobStatus; exitCode: number | null };

const globalForJobs = globalThis as typeof globalThis & {
  __sladJobs?: Map<string, PipelineJob>;
};

const jobs = globalForJobs.__sladJobs ?? new Map<string, PipelineJob>();
globalForJobs.__sladJobs = jobs;

function emit(job: PipelineJob, event: JobEvent): void {
  for (const listener of job.listeners) listener(event);
}

function appendLog(job: PipelineJob, stream: LogStream, line: string): void {
  const entry = { stream, line, at: new Date().toISOString() };
  job.logs.push(entry);
  emit(job, { type: "log", ...entry });
}

export function getJob(jobId: string): PipelineJob | undefined {
  return jobs.get(jobId);
}

export function startPipelineJob(input: {
  sessionId: string;
  intent: string;
  stage: SladPipelineStage;
  agent?: string;
  model?: string;
  harness?: "off" | "on" | "strict";
}): PipelineJob {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job: PipelineJob = {
    id,
    sessionId: input.sessionId,
    stage: input.stage,
    status: "running",
    exitCode: null,
    logs: [],
    listeners: new Set(),
  };
  jobs.set(id, job);

  setActiveSession(input.sessionId);
  const args = commandForStage(input.stage, input.intent, {
    agent: input.agent,
    model: input.model,
    harness: input.harness,
  });
  job.child = spawnSladCli(args, {
    onLog: (stream, line) => appendLog(job, stream, line),
    onExit: (code) => {
      job.child = undefined;
      if (job.status === "cancelled") return;
      job.exitCode = code;
      job.status = code === 0 ? "completed" : "failed";
      emit(job, { type: "status", status: job.status, exitCode: code });
    },
  });

  return job;
}

export function startModeJob(input: {
  intent: string;
  mode: SladRunMode;
  sessionId?: string;
  agent?: string;
  model?: string;
  debateModels?: string;
}): PipelineJob {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job: PipelineJob = {
    id,
    sessionId: input.sessionId ?? "",
    stage: input.mode,
    status: "running",
    exitCode: null,
    logs: [],
    listeners: new Set(),
  };
  jobs.set(id, job);

  if (input.sessionId) setActiveSession(input.sessionId);
  const args = commandForMode(input.mode, input.intent, { agent: input.agent, model: input.model, debateModels: input.debateModels });
  job.child = spawnSladCli(args, {
    onLog: (stream, line) => appendLog(job, stream, line),
    onExit: (code) => {
      job.child = undefined;
      if (job.status === "cancelled") return;
      job.exitCode = code;
      job.status = code === 0 ? "completed" : "failed";
      emit(job, { type: "status", status: job.status, exitCode: code });
    },
  });

  return job;
}

export function killJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job || job.status !== "running" || !job.child) return false;
  job.status = "cancelled";
  const { pid } = job.child;
  if (pid != null) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      job.child.kill("SIGTERM");
    }
    setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }, 3000);
  } else {
    job.child.kill("SIGTERM");
  }
  emit(job, { type: "status", status: "cancelled", exitCode: null });
  return true;
}

export function subscribeToJob(job: PipelineJob, listener: (event: JobEvent) => void): () => void {
  job.listeners.add(listener);
  return () => job.listeners.delete(listener);
}
