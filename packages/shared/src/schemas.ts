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

export const PIPELINE_STAGE_NAMES = [...STAGE_NAMES, "research"] as const;
export const PipelineStageName = z.enum(PIPELINE_STAGE_NAMES);
export type PipelineStageName = z.infer<typeof PipelineStageName>;

// ─── Agents ─────────────────────────────────────────────────────────────────
// A named agent binds a domain to an ordered set of pipeline stages. The CLI
// registry attaches the concrete prompts to each descriptor (see
// packages/cli/src/agents/registry.ts). This is the seam that lets the interface
// select between agents/domain-kits instead of hardwiring one pipeline.
export const AgentDescriptor = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  stages: z.array(PipelineStageName).min(1),
});
export type AgentDescriptor = z.infer<typeof AgentDescriptor>;

export const AGENT_CATALOG = z.array(AgentDescriptor).parse([
  {
    id: "developer",
    label: "Developer",
    description: "Pipeline completo de ingeniería de software: explore → snapshot → plan → run → learn.",
    stages: ["explore", "snapshot", "plan", "run", "learn"],
  },
]);

export const DEFAULT_AGENT_ID = "developer";

export const DecisionStageName = z.enum([
  "explore", "snapshot", "plan", "run", "learn", "evolve", "hitl",
  "research",
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

export const ResearchSourceId = z.string().min(1);
export type ResearchSourceId = z.infer<typeof ResearchSourceId>;

export const ResearchSourceRange = z.object({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
}).superRefine((range, ctx) => {
  if (range.endLine !== undefined && range.endLine < range.startLine) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "endLine must be greater than or equal to startLine",
      path: ["endLine"],
    });
  }
});
export type ResearchSourceRange = z.infer<typeof ResearchSourceRange>;

export const ResearchRepoSource = z.object({
  id: ResearchSourceId,
  type: z.literal("repo"),
  title: z.string().min(1).optional(),
  path: z.string().min(1),
  range: ResearchSourceRange.optional(),
  symbol: z.string().min(1).optional(),
});
export type ResearchRepoSource = z.infer<typeof ResearchRepoSource>;

export const ResearchWebSource = z.object({
  id: ResearchSourceId,
  type: z.literal("web"),
  title: z.string().min(1).optional(),
  url: z.string().url(),
  accessedAt: z.string().datetime().optional(),
});
export type ResearchWebSource = z.infer<typeof ResearchWebSource>;

export const ResearchSource = z.discriminatedUnion("type", [
  ResearchRepoSource,
  ResearchWebSource,
]);
export type ResearchSource = z.infer<typeof ResearchSource>;

export const ResearchFinding = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  citations: z.array(ResearchSourceId).min(1),
  confidence: z.number().min(0).max(1).optional(),
});
export type ResearchFinding = z.infer<typeof ResearchFinding>;

export const ResearchGap = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  impact: z.string().min(1).optional(),
  citations: z.array(ResearchSourceId).default([]),
});
export type ResearchGap = z.infer<typeof ResearchGap>;

export const ResearchRecommendation = z.object({
  id: z.string().min(1),
  recommendation: z.string().min(1),
  rationale: z.string().min(1).optional(),
  citations: z.array(ResearchSourceId).default([]),
});
export type ResearchRecommendation = z.infer<typeof ResearchRecommendation>;

export const ResearchReportArtifact = z.object({
  kind: z.literal("research_report").default("research_report"),
  path: z.string().min(1),
  format: z.enum(["json", "markdown"]).default("json"),
  title: z.string().min(1).optional(),
});
export type ResearchReportArtifact = z.infer<typeof ResearchReportArtifact>;

export const ResearchOutputMetadata = z.object({
  stage: z.literal("research").default("research"),
  artifactKind: z.literal("research_report").default("research_report"),
  sessionId: z.string().min(1).optional(),
  taskId: TaskId.optional(),
  createdAt: z.string().datetime().optional(),
  persistedAt: z.string().datetime().optional(),
});
export type ResearchOutputMetadata = z.infer<typeof ResearchOutputMetadata>;

export const ResearchOutput = z.object({
  status: z.enum(["completed", "awaiting_human"]).default("completed"),
  summary: z.string().min(1),
  scope: z.object({
    question: z.string().min(1),
    constraints: z.array(z.string().min(1)).default([]),
    repoPaths: z.array(z.string().min(1)).default([]),
    webQueries: z.array(z.string().min(1)).default([]),
  }),
  findings: z.array(ResearchFinding).default([]),
  gaps: z.array(ResearchGap).default([]),
  recommendations: z.array(ResearchRecommendation).default([]),
  sources: z.array(ResearchSource).default([]),
  artifact: ResearchReportArtifact,
  metadata: ResearchOutputMetadata.default({}),
  questions: z.array(Question).default([]),
  decisions: z.array(DecisionRecord).default([]),
}).superRefine((output, ctx) => {
  const sourceIds = new Set<ResearchSourceId>();

  for (const [index, source] of output.sources.entries()) {
    if (sourceIds.has(source.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate source id: ${source.id}`,
        path: ["sources", index, "id"],
      });
      continue;
    }

    sourceIds.add(source.id);
  }

  for (const [index, finding] of output.findings.entries()) {
    for (const [citationIndex, citation] of finding.citations.entries()) {
      if (!sourceIds.has(citation)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `finding citation references unknown source id: ${citation}`,
          path: ["findings", index, "citations", citationIndex],
        });
      }
    }
  }
});
export type ResearchOutput = z.infer<typeof ResearchOutput>;

export const RoutingMode = z.enum(["ask", "work", "work-debate"]);
export type RoutingMode = z.infer<typeof RoutingMode>;

export const RoutingDecision = z.object({
  mode: RoutingMode,
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
});
export type RoutingDecision = z.infer<typeof RoutingDecision>;

export const SlashCommandSurface = z.enum(["cli", "ui"]);
export type SlashCommandSurface = z.infer<typeof SlashCommandSurface>;

export const SlashCommandCategory = z.enum(["chat", "pipeline", "session", "meta", "observability"]);
export type SlashCommandCategory = z.infer<typeof SlashCommandCategory>;

export const SlashCommandArgType = z.enum(["string", "enum", "boolean", "path", "project", "confirm"]);
export type SlashCommandArgType = z.infer<typeof SlashCommandArgType>;

export const SlashCommandExecutionKind = z.enum(["session-message", "local-action", "dual"]);
export type SlashCommandExecutionKind = z.infer<typeof SlashCommandExecutionKind>;

const SlashCommandId = z.string().regex(/^[a-z][a-z0-9.-]*$/);
const SlashCommandAlias = z.string().min(1).regex(/^[^\s/]+$/);
const SlashCommandArgName = z.string().regex(/^[a-z][a-zA-Z0-9]*$/);
const SlashCommandMetadataValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

export const SlashCommandArgumentMetadata = z.object({
  name: SlashCommandArgName,
  placeholder: z.string().min(1).optional(),
  optional: z.boolean().default(false),
  help: z.string().min(1).optional(),
});
export type SlashCommandArgumentMetadata = z.infer<typeof SlashCommandArgumentMetadata>;

export const SlashCommandDiscoveryMetadata = z.object({
  name: SlashCommandId,
  description: z.string().min(1),
  arguments: z.array(SlashCommandArgumentMetadata).default([]),
});
export type SlashCommandDiscoveryMetadata = z.infer<typeof SlashCommandDiscoveryMetadata>;

const BaseSlashCommandArg = z.object({
  type: SlashCommandArgType,
  name: SlashCommandArgName,
  label: z.string().min(1),
  description: z.string().min(1),
  required: z.boolean().default(false),
  placeholder: z.string().optional(),
  metadata: z.record(SlashCommandMetadataValue).default({}),
});

export const SlashCommandStringArg = BaseSlashCommandArg.extend({
  type: z.literal("string"),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  pattern: z.string().optional(),
  multiline: z.boolean().default(false),
});
export type SlashCommandStringArg = z.infer<typeof SlashCommandStringArg>;

export const SlashCommandEnumArg = BaseSlashCommandArg.extend({
  type: z.literal("enum"),
  options: z
    .array(
      z.object({
        value: z.string().min(1),
        label: z.string().min(1),
        description: z.string().optional(),
      }),
    )
    .min(1),
});
export type SlashCommandEnumArg = z.infer<typeof SlashCommandEnumArg>;

export const SlashCommandBooleanArg = BaseSlashCommandArg.extend({
  type: z.literal("boolean"),
  defaultValue: z.boolean().optional(),
});
export type SlashCommandBooleanArg = z.infer<typeof SlashCommandBooleanArg>;

export const SlashCommandPathArg = BaseSlashCommandArg.extend({
  type: z.literal("path"),
  allowFiles: z.boolean().default(true),
  allowDirectories: z.boolean().default(true),
  extensions: z.array(z.string().min(1)).default([]),
});
export type SlashCommandPathArg = z.infer<typeof SlashCommandPathArg>;

export const SlashCommandProjectArg = BaseSlashCommandArg.extend({
  type: z.literal("project"),
  allowCurrentWorkspace: z.boolean().default(true),
});
export type SlashCommandProjectArg = z.infer<typeof SlashCommandProjectArg>;

export const SlashCommandConfirmArg = BaseSlashCommandArg.extend({
  type: z.literal("confirm"),
  confirmLabel: z.string().min(1).optional(),
  defaultValue: z.boolean().optional(),
  destructive: z.boolean().default(false),
});
export type SlashCommandConfirmArg = z.infer<typeof SlashCommandConfirmArg>;

export const SlashCommandArg = z.discriminatedUnion("type", [
  SlashCommandStringArg,
  SlashCommandEnumArg,
  SlashCommandBooleanArg,
  SlashCommandPathArg,
  SlashCommandProjectArg,
  SlashCommandConfirmArg,
]);
export type SlashCommandArg = z.infer<typeof SlashCommandArg>;

export const SlashCommandExecutionIntent = z.object({
  kind: SlashCommandExecutionKind.default("dual"),
  emitsSessionMessage: z.boolean().default(true),
  invokesLocalAction: z.boolean().default(true),
  localAction: z.string().min(1).optional(),
  messageTemplate: z.string().min(1).optional(),
}).superRefine((intent, ctx) => {
  if ((intent.kind === "local-action" || intent.kind === "dual") && !intent.localAction) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "localAction is required for local-action and dual execution intents",
      path: ["localAction"],
    });
  }
});
export type SlashCommandExecutionIntent = z.infer<typeof SlashCommandExecutionIntent>;

export const SlashCommandVisibility = z.object({
  hidden: z.boolean().default(false),
  experimental: z.boolean().default(false),
  enabledByDefault: z.boolean().default(true),
});
export type SlashCommandVisibility = z.infer<typeof SlashCommandVisibility>;

export const SlashCommandPermission = z.object({
  permissions: z.array(Permission).default([]),
  risk: ToolRisk.default("low"),
});
export type SlashCommandPermission = z.infer<typeof SlashCommandPermission>;

export const SlashCommandConfig = z.object({
  requiresActiveSession: z.boolean().default(false),
  requiresWorkspaceTrust: z.boolean().default(false),
  requiresProvider: z.boolean().default(false),
  requiresPlan: z.boolean().default(false),
});
export type SlashCommandConfig = z.infer<typeof SlashCommandConfig>;

export const SlashCommandMetadata = z.object({
  cliCommand: z.string().min(1).optional(),
  uiHandler: z.string().min(1).optional(),
  pipelineStage: PipelineStageName.optional(),
  keywords: z.array(z.string().min(1)).default([]),
  source: z.string().min(1).optional(),
});
export type SlashCommandMetadata = z.infer<typeof SlashCommandMetadata>;

export const SlashCommand = z.object({
  id: SlashCommandId,
  title: z.string().min(1),
  description: z.string().min(1),
  category: SlashCommandCategory,
  surfaces: z.array(SlashCommandSurface).min(1),
  args: z.array(SlashCommandArg).default([]),
  executionIntent: SlashCommandExecutionIntent,
  aliases: z.array(SlashCommandAlias).default([]),
  visibility: SlashCommandVisibility.default({}),
  permission: SlashCommandPermission.default({}),
  config: SlashCommandConfig.default({}),
  metadata: SlashCommandMetadata.default({}),
});
export type SlashCommand = z.infer<typeof SlashCommand>;

export function toSlashCommandDiscoveryMetadata(command: SlashCommand): SlashCommandDiscoveryMetadata {
  return SlashCommandDiscoveryMetadata.parse({
    name: command.id,
    description: command.description,
    arguments: command.args.map((arg) => ({
      name: arg.name,
      placeholder: arg.placeholder ?? arg.name,
      optional: !arg.required,
      help: arg.description,
    })),
  });
}

function renderSlashCommandArgumentSignature(argument: SlashCommandArgumentMetadata): string {
  const placeholder = argument.placeholder ?? argument.name;
  return argument.optional ? `[${placeholder}]` : `<${placeholder}>`;
}

export function renderSlashCommandSignature(command: SlashCommand | SlashCommandDiscoveryMetadata): string {
  const metadata =
    "arguments" in command ? SlashCommandDiscoveryMetadata.parse(command) : toSlashCommandDiscoveryMetadata(command);
  const renderedArgs = metadata.arguments.map(renderSlashCommandArgumentSignature);
  return renderedArgs.length > 0 ? `/${metadata.name} ${renderedArgs.join(" ")}` : `/${metadata.name}`;
}

export const SlashCommandCatalog = z.array(SlashCommand);
export type SlashCommandCatalog = z.infer<typeof SlashCommandCatalog>;

const SHARED_SURFACES: SlashCommandSurface[] = ["cli", "ui"];
const DUAL_MESSAGE_AND_ACTION = {
  kind: "dual",
  emitsSessionMessage: true,
  invokesLocalAction: true,
} as const;

export const SLASH_COMMAND_CATALOG = SlashCommandCatalog.parse([
  {
    id: "ask",
    title: "Ask",
    description: "Respuesta directa del modelo sin ejecutar el pipeline.",
    category: "chat",
    surfaces: SHARED_SURFACES,
    args: [],
    executionIntent: { ...DUAL_MESSAGE_AND_ACTION, localAction: "chat.ask" },
    aliases: ["question", "preguntar"],
    config: { requiresProvider: true },
    metadata: { cliCommand: "ask", uiHandler: "startModeJob:ask", keywords: ["chat", "quick-answer"] },
  },
  {
    id: "chat",
    title: "Chat",
    description: "Abrir o continuar el modo conversacional.",
    category: "chat",
    surfaces: SHARED_SURFACES,
    args: [],
    executionIntent: { ...DUAL_MESSAGE_AND_ACTION, localAction: "chat.open" },
    aliases: ["repl", "conversacion"],
    config: { requiresProvider: true },
    metadata: { cliCommand: "chat", uiHandler: "composer.focus", keywords: ["conversation"] },
  },
  {
    id: "auto",
    title: "Auto",
    description: "Ejecutar el pipeline completo: explore, snapshot, plan, run y learn.",
    category: "pipeline",
    surfaces: SHARED_SURFACES,
    args: [],
    executionIntent: { ...DUAL_MESSAGE_AND_ACTION, localAction: "pipeline.work" },
    aliases: ["work", "pipeline"],
    permission: { permissions: ["workspace:read", "workspace:write", "process:exec", "model:generate"], risk: "high" },
    config: { requiresWorkspaceTrust: true, requiresProvider: true },
    metadata: { cliCommand: "auto", uiHandler: "startModeJob:work", keywords: ["full-pipeline"] },
  },
  {
    id: "work-debate",
    title: "Work Debate",
    description: "Ejecutar el pipeline completo con debate entre modelos en explore y plan.",
    category: "pipeline",
    surfaces: SHARED_SURFACES,
    args: [],
    executionIntent: { ...DUAL_MESSAGE_AND_ACTION, localAction: "pipeline.work-debate" },
    aliases: ["debate", "auto-debate"],
    permission: { permissions: ["workspace:read", "workspace:write", "process:exec", "model:generate"], risk: "high" },
    config: { requiresWorkspaceTrust: true, requiresProvider: true },
    metadata: { cliCommand: "work --debate", uiHandler: "startModeJob:work-debate", keywords: ["full-pipeline", "arbiter"] },
  },
  {
    id: "explore",
    title: "Explore",
    description: "Analizar una intención y devolver enfoques, riesgos y próximos pasos.",
    category: "pipeline",
    surfaces: SHARED_SURFACES,
    args: [],
    executionIntent: { ...DUAL_MESSAGE_AND_ACTION, localAction: "pipeline.stage.explore" },
    aliases: ["explorar"],
    permission: { permissions: ["workspace:read", "model:generate"], risk: "medium" },
    config: { requiresProvider: true },
    metadata: { cliCommand: "explore", uiHandler: "runStage:explore", pipelineStage: "explore", keywords: ["intent"] },
  },
  {
    id: "snapshot",
    title: "Snapshot",
    description: "Generar el mini-spec a partir del último explore o de una intención.",
    category: "pipeline",
    surfaces: SHARED_SURFACES,
    args: [],
    executionIntent: { ...DUAL_MESSAGE_AND_ACTION, localAction: "pipeline.stage.snapshot" },
    permission: { permissions: ["workspace:read", "workspace:write", "model:generate"], risk: "medium" },
    config: { requiresActiveSession: true, requiresProvider: true },
    metadata: { cliCommand: "snapshot", uiHandler: "runStage:snapshot", pipelineStage: "snapshot", keywords: ["spec"] },
  },
  {
    id: "plan",
    title: "Plan",
    description: "Convertir un snapshot en un plan de tareas ejecutable.",
    category: "pipeline",
    surfaces: SHARED_SURFACES,
    args: [],
    executionIntent: { ...DUAL_MESSAGE_AND_ACTION, localAction: "pipeline.stage.plan" },
    aliases: ["planificar"],
    permission: { permissions: ["workspace:read", "workspace:write", "model:generate"], risk: "medium" },
    config: { requiresActiveSession: true, requiresProvider: true },
    metadata: { cliCommand: "plan", uiHandler: "runStage:plan", pipelineStage: "plan", keywords: ["tasks"] },
  },
  {
    id: "run",
    title: "Run",
    description: "Ejecutar la siguiente tarea del plan o el DAG completo.",
    category: "pipeline",
    surfaces: SHARED_SURFACES,
    args: [],
    executionIntent: { ...DUAL_MESSAGE_AND_ACTION, localAction: "pipeline.stage.run" },
    aliases: ["ejecutar"],
    permission: { permissions: ["workspace:read", "workspace:write", "process:exec"], risk: "high" },
    config: { requiresActiveSession: true, requiresWorkspaceTrust: true, requiresPlan: true },
    metadata: { cliCommand: "run", uiHandler: "runStage:run", pipelineStage: "run", keywords: ["builder", "reviewer"] },
  },
  {
    id: "learn",
    title: "Learn",
    description: "Capturar decisiones, errores y patrones desde el último run.",
    category: "pipeline",
    surfaces: SHARED_SURFACES,
    args: [],
    executionIntent: { ...DUAL_MESSAGE_AND_ACTION, localAction: "pipeline.stage.learn" },
    aliases: ["aprender"],
    permission: { permissions: ["workspace:read", "workspace:write", "model:generate"], risk: "medium" },
    config: { requiresActiveSession: true, requiresProvider: true },
    metadata: { cliCommand: "learn", uiHandler: "runStage:learn", pipelineStage: "learn", keywords: ["retrospective"] },
  },
  {
    id: "evolve",
    title: "Evolve",
    description: "Proponer actualizaciones de wiki y patrones desde artefactos recientes.",
    category: "pipeline",
    surfaces: SHARED_SURFACES,
    args: [],
    executionIntent: { ...DUAL_MESSAGE_AND_ACTION, localAction: "pipeline.stage.evolve" },
    aliases: ["evolucionar"],
    permission: { permissions: ["workspace:read", "workspace:write", "model:generate"], risk: "medium" },
    config: { requiresActiveSession: true, requiresProvider: true },
    metadata: { cliCommand: "evolve", uiHandler: "runStage:evolve", pipelineStage: "evolve", keywords: ["wiki", "patterns"] },
  },
  {
    id: "status",
    title: "Status",
    description: "Ver el estado de la sesión activa y sus artefactos.",
    category: "session",
    surfaces: SHARED_SURFACES,
    args: [],
    executionIntent: { ...DUAL_MESSAGE_AND_ACTION, localAction: "session.status" },
    aliases: ["estado", "show", "sesion", "sesión"],
    config: { requiresActiveSession: true },
    metadata: { cliCommand: "session show", uiHandler: "session.show", keywords: ["state"] },
  },
  {
    id: "new",
    title: "New Session",
    description: "Crear una nueva sesión de trabajo sin ejecutar etapas.",
    category: "session",
    surfaces: SHARED_SURFACES,
    args: [],
    executionIntent: { ...DUAL_MESSAGE_AND_ACTION, localAction: "session.start" },
    aliases: ["session.start", "nuevo", "nueva", "reset"],
    permission: { permissions: ["workspace:write"], risk: "medium" },
    metadata: { cliCommand: "session start", uiHandler: "session.create", keywords: ["intent"] },
  },
  {
    id: "stats",
    title: "Stats",
    description: "Mostrar totales de sesiones, runs y aprendizajes del proyecto.",
    category: "observability",
    surfaces: SHARED_SURFACES,
    args: [],
    executionIntent: { ...DUAL_MESSAGE_AND_ACTION, localAction: "stats.show" },
    aliases: ["metrics", "telemetry"],
    permission: { permissions: ["workspace:read"], risk: "low" },
    metadata: { cliCommand: "stats", uiHandler: "stats.show", keywords: ["runs", "learnings"] },
  },
  {
    id: "version",
    title: "Version",
    description: "Mostrar la versión instalada de SLAD OS.",
    category: "meta",
    surfaces: SHARED_SURFACES,
    args: [],
    executionIntent: { ...DUAL_MESSAGE_AND_ACTION, localAction: "version.show" },
    aliases: ["about"],
    metadata: { cliCommand: "version", uiHandler: "version.show", keywords: ["about"] },
  },
  {
    id: "model",
    title: "Model",
    description: "Configurar el proveedor CLI y modelo por defecto global.",
    category: "meta",
    surfaces: ["cli"],
    args: [],
    executionIntent: { ...DUAL_MESSAGE_AND_ACTION, localAction: "model.configure" },
    aliases: ["modelo"],
    permission: { permissions: ["workspace:read"], risk: "low" },
    metadata: { cliCommand: "chat:/model", keywords: ["provider", "agent", "config"] },
  },
  {
    id: "agents",
    title: "Agents",
    description: "Listar los agentes disponibles o cambiar el agente activo (ej. /agents use developer).",
    category: "meta",
    surfaces: SHARED_SURFACES,
    args: [],
    executionIntent: { ...DUAL_MESSAGE_AND_ACTION, localAction: "agents.show" },
    aliases: ["agent"],
    permission: { permissions: ["workspace:read"], risk: "low" },
    metadata: { cliCommand: "agents", uiHandler: "agents.show", keywords: ["agent", "domain", "kit", "pipeline"] },
  },
  {
    id: "help",
    title: "Help",
    description: "Mostrar la ayuda de comandos disponibles.",
    category: "meta",
    surfaces: SHARED_SURFACES,
    args: [],
    executionIntent: { ...DUAL_MESSAGE_AND_ACTION, localAction: "help.show" },
    aliases: ["ayuda", "?", "h"],
    metadata: { cliCommand: "chat:/help", uiHandler: "commandPalette.help", keywords: ["commands"] },
  },
  {
    id: "exit",
    title: "Exit",
    description: "Salir del modo conversacional o cerrar la paleta de comandos.",
    category: "meta",
    surfaces: SHARED_SURFACES,
    args: [],
    executionIntent: { ...DUAL_MESSAGE_AND_ACTION, localAction: "chat.exit" },
    aliases: ["quit", "salir", "bye", "chau", "q"],
    metadata: { cliCommand: "chat:/exit", uiHandler: "commandPalette.close", keywords: ["close"] },
  },
]);
export type SlashCommandId = (typeof SLASH_COMMAND_CATALOG)[number]["id"];

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
  activeAgentId: z.string().default("developer"),
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
