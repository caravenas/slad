import ora, { type Ora } from "ora";
import kleur from "kleur";
import { getFormattedCliVersion } from "./version.js";

export type BootMilestone = "config" | "fs" | "persistence";

export type BootEvent =
  | { type: "banner"; content: string }
  | { type: "start"; message: string }
  | { type: "milestone"; milestone: BootMilestone; message: string }
  | { type: "succeed"; message: string }
  | { type: "error"; message: string; lingerMs: number }
  | { type: "stop" };

export type BootEventHandler = (event: BootEvent) => void;

export type BootUiOptions = {
  enabled?: boolean;
  onEvent?: BootEventHandler;
  errorLingerMs?: number;
};

export type BootUi = {
  showBanner(): Promise<void>;
  start(message: string): void;
  milestone(milestone: BootMilestone, message?: string): void;
  succeed(message: string): void;
  fail(message: string, opts?: { lingerMs?: number }): Promise<void>;
  stop(): void;
};

const milestoneLabel: Record<BootMilestone, string> = {
  config: "configuración",
  fs: "filesystem",
  persistence: "persistencia",
};

function shouldRenderBootUi(): boolean {
  return Boolean(process.stdout.isTTY && process.stderr.isTTY && process.env.CI === undefined);
}

function createNullBootUi(onEvent?: BootEventHandler): BootUi {
  const emit = (event: BootEvent): void => {
    onEvent?.(event);
  };

  return {
    async showBanner(): Promise<void> {
      emit({ type: "banner", content: "" });
    },
    start(message: string): void {
      emit({ type: "start", message });
    },
    milestone(milestone: BootMilestone, message?: string): void {
      emit({ type: "milestone", milestone, message: message ?? milestoneLabel[milestone] });
    },
    succeed(message: string): void {
      emit({ type: "succeed", message });
    },
    async fail(message: string, opts?: { lingerMs?: number }): Promise<void> {
      emit({ type: "error", message, lingerMs: opts?.lingerMs ?? 0 });
      emit({ type: "stop" });
    },
    stop(): void {
      emit({ type: "stop" });
    },
  };
}

export const LOGO_LINES = [
  kleur.cyan("  ▄▄▄▄▄▄  "),
  kleur.cyan("▄████████▄"),
  kleur.cyan("██ ▀  ▀ ██"),
  kleur.cyan("▀████████▀"),
  kleur.cyan("  ▀▀  ▀▀  "),
];

function displayCwd(): string {
  const cwd = process.cwd();
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

/** Full-width bordered header block for the interactive chat. */
export function makeHeader(version: string): string {
  const lines = [
    `${LOGO_LINES[0]}   ${kleur.bold().white("SLAD")} ${kleur.dim(version)}`,
    `${LOGO_LINES[1]}   ${kleur.dim("Agentic CLI with high effort")}`,
    `${LOGO_LINES[2]}   ${kleur.dim(displayCwd())}`,
    LOGO_LINES[3]!,
    LOGO_LINES[4]!
  ];

  return lines.join("\n");
}

function formatBanner(version: string): string {
  const lines = [
    `${LOGO_LINES[0]}   ${kleur.bold().white("SLAD")} ${kleur.dim(version)}`,
    `${LOGO_LINES[1]}   ${kleur.dim("Agentic CLI with high effort")}`,
    `${LOGO_LINES[2]}   ${kleur.dim(displayCwd())}`,
    LOGO_LINES[3]!,
    LOGO_LINES[4]!,
  ];

  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeVersion(formattedVersion: string): string {
  return formattedVersion.startsWith("slad ") ? `v${formattedVersion.slice(5)}` : formattedVersion;
}

export function createBootUi(opts: BootUiOptions = {}): BootUi {
  const enabled = opts.enabled ?? shouldRenderBootUi();
  const emit = (event: BootEvent): void => {
    opts.onEvent?.(event);
  };

  if (!enabled) {
    return createNullBootUi(opts.onEvent);
  }

  const spinner: Ora = ora();
  const defaultLingerMs = opts.errorLingerMs ?? 900;

  return {
    async showBanner(): Promise<void> {
      const version = normalizeVersion(await getFormattedCliVersion());
      const banner = formatBanner(version);
      emit({ type: "banner", content: banner });
      process.stdout.write(`${banner}\n`);
    },
    start(message: string): void {
      emit({ type: "start", message });
      spinner.start(message);
    },
    milestone(milestone: BootMilestone, message?: string): void {
      const resolvedMessage = message ?? `Inicializando ${milestoneLabel[milestone]}...`;
      emit({ type: "milestone", milestone, message: resolvedMessage });
      if (spinner.isSpinning) {
        spinner.text = resolvedMessage;
      } else {
        spinner.start(resolvedMessage);
      }
    },
    succeed(message: string): void {
      emit({ type: "succeed", message });
      spinner.succeed(message);
    },
    async fail(message: string, failOpts?: { lingerMs?: number }): Promise<void> {
      const lingerMs = failOpts?.lingerMs ?? defaultLingerMs;
      emit({ type: "error", message, lingerMs });
      spinner.fail(message);
      if (lingerMs > 0) {
        await sleep(lingerMs);
      }
      spinner.stop();
      emit({ type: "stop" });
    },
    stop(): void {
      spinner.stop();
      emit({ type: "stop" });
    },
  };
}
