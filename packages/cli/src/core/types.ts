import { z } from "zod";
import { AgentName, ProviderName } from "@slad/shared";

export {
  ProviderName,
  AgentName,
  AGENT_CATALOG,
  AgentDescriptor,
  DEFAULT_AGENT_ID,
  MessageRole,
  ChatMessage,
  Question,
  QuestionKind,
  DecisionRecord,
  ExploreOutput,
  SnapshotOutput,
  TaskId,
  LearnTaskId,
  PipelineStageName,
  PlanTask,
  PlanOutput,
  RunOutput,
  LearnOutput,
  EvolveOutput,
  SessionArtifactKind,
  SessionArtifact,
  SessionAnswer,
  SessionState,
} from "@slad/shared";

export type { CompletionOptions } from "@slad/model-providers";

export {
  SlashCommand,
  SlashCommandArgumentMetadata,
  SlashCommandCatalog,
  SlashCommandDiscoveryMetadata,
  SlashCommandSurface,
  renderSlashCommandSignature,
  toSlashCommandDiscoveryMetadata,
} from "@slad/shared";
export type {
  SlashCommand as SlashCommandType,
  SlashCommandArgumentMetadata as SlashCommandArgumentMetadataType,
  SlashCommandCatalog as SlashCommandCatalogType,
  SlashCommandDiscoveryMetadata as SlashCommandDiscoveryMetadataType,
  SlashCommandId,
  SlashCommandSurface as SlashCommandSurfaceType,
} from "@slad/shared";

export const CliSlashCommandPayload = z
  .object({
    commandId: z.string().min(1),
    args: z.record(z.never()).default({}),
  })
  .strict();
export type CliSlashCommandPayload = z.infer<typeof CliSlashCommandPayload>;

export type CliSlashCommandHandlerResult<TLocalAction = unknown> = {
  localAction?: TLocalAction;
  sessionMessage?: string;
};

export type CliSlashCommandHandler<TLocalAction = unknown> = (
  payload: CliSlashCommandPayload,
) => CliSlashCommandHandlerResult<TLocalAction> | Promise<CliSlashCommandHandlerResult<TLocalAction>>;

export const CliDiscoveryArtifact = z.object({
  candidates: z.array(
    z.object({
      name: z.string().min(1),
      path: z.string().min(1),
      provider: ProviderName,
      score: z.number().min(0),
    }),
  ),
  pathHash: z.string().min(1),
  confidenceScore: z.number().min(0).max(1),
  status: z.enum(["single_match", "multiple_matches", "no_matches", "cached"]),
});
export type CliDiscoveryArtifact = z.infer<typeof CliDiscoveryArtifact>;

export const CliCandidate = z.object({
  binary: z.string().min(1),
  resolvedPath: z.string().min(1),
  version: z.string().min(1),
  evidence: z.array(z.string()),
  confidenceScore: z.number().min(0).max(1),
  conflicts: z.array(z.string()),
});
export type CliCandidate = z.infer<typeof CliCandidate>;

export const DiscoveryResult = z.object({
  candidates: z.array(CliCandidate),
  selected: CliCandidate.optional(),
  pathHash: z.string().regex(/^[a-fA-F0-9]{64}$/),
  status: z.enum(["resolved", "ambiguous", "empty"]),
});
export type DiscoveryResult = z.infer<typeof DiscoveryResult>;

export const DevAgentConfig = z.object({
  defaultProvider: ProviderName.default("cli"),
  defaultAgent: AgentName.optional().describe("Agente CLI a usar por defecto cuando no se pasa --agent"),
  wikiPath: z
    .string()
    .optional()
    .describe("Ruta absoluta a la wiki para inyectar contexto (index.md)"),
});
export type DevAgentConfig = z.infer<typeof DevAgentConfig>;

export const InventoryProvider = z.object({
  name: z.string(),
  type: z.enum(["api", "cli"]),
  file: z.string(),
  details: z.array(z.string()),
});
export type InventoryProvider = z.infer<typeof InventoryProvider>;

export const InventoryCommand = z.object({
  name: z.string(),
  file: z.string(),
  hasHitl: z.boolean(),
  inputSchema: z.string().optional(),
  outputSchema: z.string().optional(),
});
export type InventoryCommand = z.infer<typeof InventoryCommand>;

export const InventorySchema = z.object({
  name: z.string(),
  fields: z.array(z.string()),
});
export type InventorySchema = z.infer<typeof InventorySchema>;

export const ProjectInventory = z.object({
  generatedAt: z.string(),
  contentHash: z.string(),
  providers: z.array(InventoryProvider),
  commands: z.array(InventoryCommand),
  schemas: z.array(InventorySchema),
  cacheSystem: z.object({
    enabled: z.boolean(),
    strategy: z.string(),
  }),
  harness: z.object({
    enabled: z.boolean(),
    modes: z.array(z.string()),
  }),
});
export type ProjectInventory = z.infer<typeof ProjectInventory>;

export const ProjectConfig = z.object({
  docsPath: z.string().default("docs"),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;
