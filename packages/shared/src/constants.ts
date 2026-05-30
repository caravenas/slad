export const STAGE_NAMES = ["explore", "snapshot", "plan", "run", "learn", "evolve"] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export const AUTO_STAGE_NAMES = ["explore", "snapshot", "plan", "run", "learn"] as const;
export type AutoStageName = (typeof AUTO_STAGE_NAMES)[number];
