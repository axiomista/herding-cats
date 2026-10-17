// Reads and validates environment variables (spec: Auth and security > Environment variables).

export interface Config {
  boxClientId: string;
  boxClientSecret: string;
  boxEnterpriseId: string;
  scanFolderId: string;
  auditFolderId: string;
  webhookPrimaryKey: string;
  webhookSecondaryKey: string;
  mode: "dry-run" | "apply";
  sweepIntervalMinutes: number;
  orgName: string;
  demoPasscode: string;
  sessionSecret: string;
  port: number;
  fakeBox: boolean; // (new) FAKE_BOX=1 runs on test fixtures with no Box calls
  match: { matchThreshold: number; possibleThreshold: number; highCertaintyScore: number; rivalGap: number;
           dedupeThreshold: number; dateToleranceDays: number };
  maxFileBytes: number;
  parallelFiles: number;
  aiMonthlyBudget?: number; // (new) BOX_AI_MONTHLY_BUDGET: shown beside the AI call count
}

// Matching thresholds live in config so they can be tuned against the answer key.
export const MATCH_DEFAULTS: Config["match"] = {
  matchThreshold: 85, possibleThreshold: 60, highCertaintyScore: 90, rivalGap: 10,
  dedupeThreshold: 80, dateToleranceDays: 1,
};

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const fakeBox = env.FAKE_BOX === "1";
  const missing: string[] = [];
  const need = (name: string, fakeDefault?: string): string => {
    const v = env[name];
    if (v) return v;
    if (fakeBox && fakeDefault !== undefined) return fakeDefault;
    missing.push(name);
    return "";
  };

  const mode = env.MODE ?? "dry-run";
  if (mode !== "dry-run" && mode !== "apply") throw new Error(`MODE must be dry-run or apply, got ${mode}`);

  const config: Config = {
    boxClientId: need("BOX_CLIENT_ID", "fake"),
    boxClientSecret: need("BOX_CLIENT_SECRET", "fake"),
    boxEnterpriseId: need("BOX_ENTERPRISE_ID", "fake"),
    scanFolderId: need("BOX_SCAN_FOLDER_ID", "428423214478"),
    auditFolderId: need("BOX_AUDIT_FOLDER_ID", "428424620757"),
    webhookPrimaryKey: need("BOX_WEBHOOK_PRIMARY_KEY", "fake-primary"),
    webhookSecondaryKey: need("BOX_WEBHOOK_SECONDARY_KEY", "fake-secondary"),
    mode,
    sweepIntervalMinutes: Number(env.SWEEP_INTERVAL_MINUTES ?? 15),
    orgName: env.ORG_NAME ?? (fakeBox ? "Nyanland-Meowtani Corporation" : need("ORG_NAME")),
    demoPasscode: need("DEMO_PASSCODE"),
    sessionSecret: need("SESSION_SECRET", "fake-session-secret"),
    port: Number(env.PORT ?? 3000),
    fakeBox,
    match: { ...MATCH_DEFAULTS },
    maxFileBytes: 5 * 1024 * 1024,
    parallelFiles: 4,
  };
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  if (env.BOX_AI_MONTHLY_BUDGET) {
    const budget = Number(env.BOX_AI_MONTHLY_BUDGET);
    if (!Number.isInteger(budget) || budget <= 0) {
      throw new Error(`BOX_AI_MONTHLY_BUDGET must be a positive whole number, got ${env.BOX_AI_MONTHLY_BUDGET}`);
    }
    config.aiMonthlyBudget = budget;
  }
  if (!Number.isFinite(config.sweepIntervalMinutes) || config.sweepIntervalMinutes <= 0) {
    throw new Error("SWEEP_INTERVAL_MINUTES must be a positive number");
  }
  if (config.auditFolderId === config.scanFolderId) {
    throw new Error("BOX_AUDIT_FOLDER_ID must not be the scan folder");
  }
  return config;
}

// The app refuses to run if the audit folder is inside the scan folder; otherwise it would read
// its own audit entries as new documents. `ancestors` is the audit folder's path from the root.
export function assertAuditOutsideScan(scanFolderId: string, auditFolderId: string, ancestors: string[]): void {
  if (auditFolderId === scanFolderId || ancestors.includes(scanFolderId)) {
    throw new Error("The audit folder is the scan folder or inside it; refusing to start");
  }
}
