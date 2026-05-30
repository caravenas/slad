import { z } from "zod";
import { STAGE_NAMES } from "./constants.js";

// ─── Granular permissions ────────────────────────────────────────────────────

export const PERMISSIONS = [
  "workspace:read",
  "workspace:write",
  "workspace:delete",
  "process:exec",
  "network:read",
  "network:write",
  "memory:read",
  "memory:write",
  "model:generate",
] as const;

export const Permission = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof Permission>;

/** Legacy 3-level permission kept for backward compat with harness/CLI */
export const LegacyPermissionLevel = z.enum(["read", "workspace", "full"]);
export type LegacyPermissionLevel = z.infer<typeof LegacyPermissionLevel>;

const LEGACY_MAP: Record<LegacyPermissionLevel, readonly Permission[]> = {
  read: ["workspace:read"],
  workspace: ["workspace:read", "workspace:write"],
  full: ["workspace:read", "workspace:write", "workspace:delete", "process:exec", "network:read", "network:write"],
};

/** Convert a legacy permission level to granular permissions */
export function legacyToGranular(level: LegacyPermissionLevel): Permission[] {
  return [...LEGACY_MAP[level]];
}

/** Convert granular permissions to the highest matching legacy level */
export function granularToLegacy(permissions: readonly Permission[]): LegacyPermissionLevel {
  const set = new Set(permissions);
  if (set.has("process:exec") || set.has("workspace:delete") || set.has("network:write")) return "full";
  if (set.has("workspace:write")) return "workspace";
  return "read";
}

export const ToolRisk = z.enum(["low", "medium", "high"]);
export type ToolRisk = z.infer<typeof ToolRisk>;


export const ProviderName = z.enum(["anthropic", "openai", "gemini", "cli"]);
export type ProviderName = z.infer<typeof ProviderName>;

export const AgentName = z.enum(["codex", "claude", "gemini", "agent"]);
export type AgentName = z.infer<typeof AgentName>;

export const MessageRole = z.enum(["system", "user", "assistant"]);
export type MessageRole = z.infer<typeof MessageRole>;

export const ChatMessage = z.object({
  role: MessageRole,
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const QuestionKind = z.enum(["free", "choice", "confirm", "ranking"]);
export type QuestionKind = z.infer<typeof QuestionKind>;

export const Question = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  kind: QuestionKind,
  choices: z.array(z.string()).optional(),
  default: z
    .union([z.string(), z.boolean(), z.number()])
    .optional()
    .transform((v) => (v === undefined ? undefined : String(v))),
  blocking: z.boolean().default(true),
  context: z.string().optional(),
});
export type Question = z.infer<typeof Question>;

export const TaskId = z.string().regex(/^T\d+$/);
export type TaskId = z.infer<typeof TaskId>;

export const LearnTaskId = z.union([TaskId, z.literal("all")]);
export type LearnTaskId = z.infer<typeof LearnTaskId>;

export const PipelineStageName = z.enum(STAGE_NAMES);
export type PipelineStageName = z.infer<typeof PipelineStageName>;

export const DecisionStageName = z.enum([
  "explore", "snapshot", "plan", "run", "learn", "evolve", "hitl",
]);
export type DecisionStageName = z.infer<typeof DecisionStageName>;

export const DecisionRecord = z.object({
  id: z.string().min(1),
  stage: DecisionStageName,
  taskId: TaskId.optional(),
  decision: z.string().min(1),
  alternatives: z
    .array(z.object({ option: z.string(), rejectedBecause: z.string() }))
    .default([]),
  rationale: z.string().default(""),
  evidence: z
    .array(
      z.object({
        kind: z.enum([
          "explore-output",
          "snapshot",
          "tool-result",
          "human-answer",
          "file-content",
          "debate-result",
          "external",
        ]),
        ref: z.string(),
      }),
    )
    .default([]),
  reversibility: z.enum(["trivial", "moderate", "hard", "permanent"]),
  confidence: z.number().min(0).max(1).optional(),
  supersedes: z.array(z.string()).default([]),
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;

export const ExploreOutput = z.object({
  status: z.enum(["completed", "awaiting_human"]).default("completed"),
  intent: z.string(),
  reframing: z.string(),
  approaches: z
    .array(
      z.object({
        name: z.string(),
        summary: z.string(),
        pros: z.array(z.string()),
        cons: z.array(z.string()),
      }),
    )
    .min(1),
  risks: z.array(z.string()),
  openQuestions: z.array(z.string()),
  recommendedNext: z.string(),
  questions: z.array(Question).default([]),
  decisions: z.array(DecisionRecord).default([]),
});
export type ExploreOutput = z.infer<typeof ExploreOutput>;

export const SnapshotOutput = z.object({
  status: z.enum(["completed", "awaiting_human"]).default("completed"),
  content: z.string().default(""),
  questions: z.array(Question).default([]),
});
export type SnapshotOutput = z.infer<typeof SnapshotOutput>;

export const PlanTask = z.object({
  id: TaskId,
  title: z.string(),
  description: z.string(),
  type: z.enum(["research", "implementation", "test", "docs", "review"]),
  priority: z.enum(["high", "medium", "low"]),
  dependsOn: z.array(TaskId).default([]),
  files: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).min(1),
});
export type PlanTask = z.infer<typeof PlanTask>;

export const PlanOutput = z.object({
  status: z.enum(["completed", "awaiting_human"]).default("completed"),
  snapshot: z.string(),
  summary: z.string(),
  tasks: z.array(PlanTask).default([]),
  verification: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  recommendedFirstTask: TaskId.optional(),
  questions: z.array(Question).default([]),
  decisions: z.array(DecisionRecord).default([]),
});
export type PlanOutput = z.infer<typeof PlanOutput>;

export const RoutingMode = z.enum(["ask", "work", "work-debate"]);
export type RoutingMode = z.infer<typeof RoutingMode>;

export const RoutingDecision = z.object({
  mode: RoutingMode,
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
});
export type RoutingDecision = z.infer<typeof RoutingDecision>;

export const AgentRunLog = z.object({
  sessionId: z.string(),
  intent: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number().nonnegative(),
  commandUsed: RoutingMode,
  model: z.string().optional(),
  provider: z.string().optional(),
  pipelineStatus: z.enum(["completed", "partial", "failed"]).optional(),
  stagesCompleted: z.array(z.string()).default([]),
  estimatedCostUsd: z.number().nonnegative().optional(),
  classifierResult: z.object({
    suggestedMode: RoutingMode,
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
    shownToUser: z.boolean(),
    userAccepted: z.boolean(),
  }).optional(),
  debateUsed: z.boolean().default(false),
  debateConsensusScores: z.object({
    explore: z.number().min(0).max(1).optional(),
    plan: z.number().min(0).max(1).optional(),
  }).optional(),
});
export type AgentRunLog = z.infer<typeof AgentRunLog>;

export const DebateStage = z.enum(["explore", "plan"]);
export type DebateStage = z.infer<typeof DebateStage>;

export const DebateProposal = z.object({
  modelId: z.string().min(1),
  output: z.union([ExploreOutput, PlanOutput]),
  durationMs: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});
export type DebateProposal = z.infer<typeof DebateProposal>;

export const DebateResult = z.object({
  stage: DebateStage,
  proposals: z.array(DebateProposal).min(2),
  agreements: z.array(z.string()).default([]),
  disagreements: z.array(z.object({
    field: z.string(),
    values: z.array(z.string()),
  })).default([]),
  consolidated: z.union([ExploreOutput, PlanOutput]),
  rationale: z.string(),
  consensusScore: z.number().min(0).max(1),
  arbiterModelId: z.string(),
});
export type DebateResult = z.infer<typeof DebateResult>;

export const RunOutput = z.object({
  taskId: TaskId,
  status: z.enum(["completed", "blocked", "failed", "awaiting_human"]),
  summary: z.string(),
  changedFiles: z.array(z.string()).default([]),
  verification: z
    .array(
      z.object({
        command: z.string(),
        status: z
          .string()
          .transform((v) =>
            (["passed", "failed", "not_run", "skipped", "not_applicable"] as const).includes(
              v as never,
            )
              ? (v as "passed" | "failed" | "not_run" | "skipped" | "not_applicable")
              : ("not_run" as const),
          ),
        notes: z.string().default(""),
      }),
    )
    .default([]),
  reviewerNotes: z.array(z.string()).default([]),
  followUps: z.array(z.string()).default([]),
  questions: z.array(Question).default([]),
  humanAnswers: z.record(z.string(), z.string()).default({}),
  decisions: z.array(DecisionRecord).default([]),
});
export type RunOutput = z.infer<typeof RunOutput>;

export const LearnOutput = z.object({
  status: z.enum(["completed", "awaiting_human"]).default("completed"),
  sourceRun: z.string(),
  taskId: LearnTaskId,
  summary: z.string(),
  decisions: z.array(DecisionRecord).default([]),
  errors: z.array(z.string()).default([]),
  patterns: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  followUps: z.array(z.string()).default([]),
  wikiEntryTitle: z.string(),
  questions: z.array(Question).default([]),
});
export type LearnOutput = z.infer<typeof LearnOutput>;

export const EvolveOutput = z.object({
  status: z.enum(["completed", "awaiting_human"]).default("completed"),
  title: z.string(),
  summary: z.string(),
  proposedUpdates: z
    .array(
      z.object({
        target: z.string(),
        changeType: z
          .string()
          .transform((v) =>
            (["create", "update", "append"] as const).includes(v as never)
              ? (v as "create" | "update" | "append")
              : ("update" as const),
          ),
        rationale: z.string().default(""),
        content: z.string().default(""),
      }),
    )
    .default([]),
  patternUpdates: z.array(z.string()).default([]),
  snapshotUpdates: z.array(z.string()).default([]),
  nextActions: z.array(z.string()).default([]),
  questions: z.array(Question).default([]),
});
export type EvolveOutput = z.infer<typeof EvolveOutput>;

export const SessionArtifactKind = z.enum([
  "explore",
  "snapshot",
  "plan",
  "run",
  "learn",
  "evolve",
  "cli-discovery",
]);
export type SessionArtifactKind = z.infer<typeof SessionArtifactKind>;

export const SessionArtifact = z.object({
  kind: SessionArtifactKind,
  path: z.string(),
  createdAt: z.string().datetime(),
  taskId: z.string().optional(),
});
export type SessionArtifact = z.infer<typeof SessionArtifact>;

export const SessionAnswer = z.object({
  taskId: z.string(),
  questionId: z.string(),
  answer: z.string(),
  askedAt: z.string().datetime(),
});
export type SessionAnswer = z.infer<typeof SessionAnswer>;

export const SessionState = z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  archivedAt: z.string().datetime().optional(),
  intent: z.string(),
  currentPhase: SessionArtifactKind.optional(),
  artifacts: z.array(SessionArtifact).default([]),
  humanAnswers: z.array(SessionAnswer).default([]),
  notes: z.array(z.string()).default([]),
});
export type SessionState = z.infer<typeof SessionState>;

export const SladProfile = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  agent: AgentName.optional(),
  provider: ProviderName.optional(),
  model: z.string().optional(),
  promptGuidance: z.record(PipelineStageName, z.string()).default({}),
});
export type SladProfile = z.infer<typeof SladProfile>;

export const SladHarnessSettings = z.object({
  mode: z.enum(["off", "on", "strict"]).default("on"),
  maxPermission: z.enum(["read", "workspace", "full"]).default("workspace"),
  alwaysApprove: z.array(z.string()).default([
    "rm -rf",
    "sudo",
    "shutdown",
    "DROP TABLE",
    "git push --force",
    "npm publish",
  ]),
  allowedWritePaths: z.array(z.string()).default(["./src", "./tests", "./docs"]),
  auditLog: z.boolean().default(true),
  auditLogPath: z.string().default(".slad-os/audit.ldjson"),
  preTaskHooks: z.array(z.string()).default([]),
  postTaskHooks: z.array(z.string()).default([]),
});
export type SladHarnessSettings = z.infer<typeof SladHarnessSettings>;

export const SladSettings = z.object({
  activeProfileId: z.string().optional(),
  profiles: z.array(SladProfile).default([]),
  providers: z.object({
    defaultProvider: ProviderName.default("anthropic"),
    models: z.record(ProviderName, z.string()).default({}),
    apiKeyEnv: z.record(ProviderName, z.string()).default({
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      gemini: "GEMINI_API_KEY",
      cli: "",
    }),
  }).default({}),
  harness: SladHarnessSettings.default({}),
  paths: z.object({
    docsPath: z.string().default("packages/cli/docs"),
    wikiPath: z.string().optional(),
    activeWorkspace: z.string().optional(),
  }).default({}),
  runtime: z.object({
    apiTimeoutMs: z.number().int().positive().optional(),
    cliTimeoutMs: z.number().int().positive().optional(),
    cliInheritApiKeys: z.boolean().default(false),
    cliArgs: z.record(z.string(), z.string()).default({}),
  }).default({}),
});
export type SladSettings = z.infer<typeof SladSettings>;
