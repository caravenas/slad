import type { PipelineStageProgress } from "@slad/pipeline/slad";
import type { PipelineStageName, QuestionKind, SlashCommand, SlashCommandId, TaskId } from "@slad/shared";

export type StageStatus = PipelineStageProgress;

export interface UISession {
  id: string;
  intent: string;
  archivedAt?: string | null;
  updatedAt: string;
  stages: StageStatus[];
  activeStage: number;
  tokens: number;
  costUsd: number;
  provider: {
    vendor: string;
    model: string;
  };
  cacheHits: number;
  cacheMisses: number;
  runMode?: "live" | "hitl";
  tasksTotal?: number;
  tasksDone?: number;
  hitlRound?: number;
  hitlMax?: number;
  isActive?: boolean;
}

export interface UIPlanTask {
  id: TaskId;
  title: string;
  deps: TaskId[];
  files: string[];
  accept: string;
  verify: string[];
}

export interface UIQuestionOption {
  v: string;
  label: string;
  hint?: string;
}

export interface UIQuestion {
  id: string;
  kind: QuestionKind;
  prompt: string;
  context?: string;
  options?: UIQuestionOption[];
  selected?: string;
  value?: string | boolean | null;
  items?: UIQuestionOption[];
}

export interface UIThreadItem {
  kind: "section" | "thought" | "tool";
  text?: string;
  icon?: string;
  name?: string;
  arg?: string;
  ts?: string;
  meta?: string;
}

export interface UIFileChange {
  path: string;
  add: number;
  rem: number;
  deleted?: boolean;
}

export interface UIVerification {
  cmd: string;
  state: "done" | "running" | "pending" | "failed";
  dur: string;
}

export interface UIDiffLine {
  k: "hunk" | "add" | "rem" | "ctx";
  t: string;
}

export interface UIDiffBlock {
  id: string;
  title: string;
  state: "apply" | "pending" | "reject";
  lines: UIDiffLine[];
}

export interface UIKnowledgeItem {
  cat: "decision" | "pattern" | "error" | "followup";
  proj?: string;
  session?: string;
  time?: string;
  text: string;
}

export interface UIDecisionRecord {
  id: string;
  stage: string;
  decision: string;
  reversibility: "trivial" | "moderate" | "hard" | "permanent";
  rationale?: string;
  alternatives?: Array<{ option: string; rejectedBecause: string }>;
  confidence?: number;
}

export interface UISessionDetail {
  explore?: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
  questionsByStage?: Partial<Record<UIStageName, UIQuestion[]>>;
  plan?: {
    goal: string;
    tasks: UIPlanTask[];
  };
  runActiveTask?: TaskId;
  runThread?: UIThreadItem[];
  files?: UIFileChange[];
  verify?: UIVerification[];
  activeFile?: string;
  activeFileDiff?: UIDiffLine[];
  questions?: UIQuestion[];
  decisions?: UIDecisionRecord[];
  evolve?: {
    agentsDiff: UIDiffBlock[];
    wikiDiff: UIDiffBlock[];
  };
  learn?: UIKnowledgeItem[];
}

export interface UIArtifact {
  schema?: string;
  goal?: string;
  constraints?: Record<string, unknown>;
  tasks?: Array<Record<string, unknown>>;
  cache?: Record<string, unknown>;
  awaiting_human?: boolean;
  questions?: UIQuestion[];
  estimated?: Record<string, unknown>;
}

export type UIStageName = PipelineStageName;

export interface UITelemetryStats {
  totalRuns: number;
  byCommand: { ask: number; work: number; "work-debate": number };
  byStatus: { completed: number; partial: number; failed: number };
  debateRuns: number;
  avgDebateConsensus: number | null;
  classifierShown: number;
  classifierAccepted: number;
  avgDurationMs: number | null;
}

export interface UISlashCommandContext {
  activeSessionId?: string | null;
  hasWorkspaceTrust?: boolean;
  hasProvider?: boolean;
  hasPlan?: boolean;
  allowExperimental?: boolean;
}

export interface UISlashCommandAvailability {
  visible: boolean;
  executable: boolean;
  reason?: string;
}

export interface UISlashCommandPaletteItem {
  command: SlashCommand;
  availability: UISlashCommandAvailability;
  matchedBy: "id" | "title" | "alias" | "category" | "keyword" | "all";
}

export interface UISlashCommandResult {
  ok: boolean;
  status: "executed" | "info" | "validation-error" | "not-executable";
  message?: string;
}

export type UISlashCommandHandler = (command: SlashCommand) => void | UISlashCommandResult | Promise<void | UISlashCommandResult>;
export type UISlashCommandHandlerMap = Partial<Record<SlashCommandId | string, UISlashCommandHandler>>;
