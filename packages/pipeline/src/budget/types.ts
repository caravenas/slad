import { z } from "zod";
import { AUTO_STAGE_NAMES } from "@slad/shared";

/** Configuración del scratchpad */
export const ScratchpadConfig = z.object({
  /** Directorio donde se almacenan los archivos scratch */
  scratchDir: z.string().default(".slad-os/scratch"),
  /** Umbral en caracteres para enviar un result al scratch en vez del context */
  charThreshold: z.number().default(2000),
  /** Umbral en líneas */
  lineThreshold: z.number().default(100),
  /** Máximo de rounds completos a mantener en context (los anteriores se comprimen) */
  maxFullRoundsInContext: z.number().default(4),
  /** Si true, incluir hint al LLM de que puede re-leer desde scratch */
  includeRereadHint: z.boolean().default(true),
});
export type ScratchpadConfig = z.infer<typeof ScratchpadConfig>;

/** Entrada en el scratchpad — metadata de un tool result almacenado */
export const ScratchpadEntry = z.object({
  id: z.string(),
  round: z.number(),
  toolName: z.string(),
  /** Argumentos originales del tool call */
  args: z.record(z.unknown()),
  /** Resumen corto para mantener en context */
  summary: z.string(),
  /** Path al archivo con el resultado completo */
  filePath: z.string(),
  /** Tamaño original en chars */
  originalSize: z.number(),
  /** Timestamp */
  createdAt: z.string(),
});
export type ScratchpadEntry = z.infer<typeof ScratchpadEntry>;

/** Estado del budget de tokens */
export const BudgetState = z.object({
  /** Tokens de input acumulados */
  inputTokens: z.number().default(0),
  /** Tokens de output acumulados */
  outputTokens: z.number().default(0),
  /** Costo estimado en USD */
  estimatedCostUsd: z.number().default(0),
  /** Desglose por stage */
  byStage: z
    .record(
      z.string(),
      z.object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        estimatedCostUsd: z.number(),
        calls: z.number(),
      }),
    )
    .default({}),
  /** Budget máximo (0 = sin límite) */
  maxCostUsd: z.number().default(0),
  /** Budget máximo de tokens (0 = sin límite) */
  maxTokens: z.number().default(0),
});
export type BudgetState = z.infer<typeof BudgetState>;

/** Report final de una ejecución auto */
export const AutoReport = z.object({
  intent: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number(),
  status: z.enum(["completed", "partial", "failed", "aborted"]),
  /** Qué stages completaron */
  stagesCompleted: z.array(z.enum(AUTO_STAGE_NAMES)),
  /** Stage donde se detuvo (si no completó) */
  stoppedAt: z.string().optional(),
  stopReason: z.string().optional(),
  /** Paths a los artifacts generados */
  artifacts: z.record(z.string(), z.string()).default({}),
  /** Budget consumido */
  budget: BudgetState,
  /** Resumen de tasks ejecutadas en run */
  tasksSummary: z
    .object({
      total: z.number(),
      completed: z.number(),
      failed: z.number(),
      skipped: z.number(),
    })
    .optional(),
});
export type AutoReport = z.infer<typeof AutoReport>;
