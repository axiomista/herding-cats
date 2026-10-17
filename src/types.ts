// Shared types. The spec's types come first; additions marked (new) are from the work breakdown
// or DECISIONS.md. The browser script keeps a copy of the response shapes it uses (web/app.ts).

export type Bucket = "superseded" | "owner_conflict" | "date_conflict" | "misfiled"
            | "matched" | "untracked" | "orphan";

export interface Commitment { id: string; fileId: string; fileVersion: string; text: string;
  evidence: string; owner?: string; ownerUserId?: string; due?: string; status: "open" | "done" | "cancelled";
  // (new) Fields the matcher, certainty checks and cards need.
  flags?: string[];                                  // e.g. "owner unresolved", "date relative"
  dueAbsolute?: boolean;                             // due was written as an explicit date
  mentions?: { fileId: string; evidence: string }[]; // restatements merged into this commitment
  // The sentence that cancelled or completed it, and how well it matched this commitment.
  statusEvidence?: { fileId: string; evidence: string; score?: number };
}

export interface TrackerTask { id: string; fileId: string; message: string;
  assigneeIds: string[]; due?: string; completed: boolean; }

export interface Finding { id: string; bucket: Bucket; certainty: "high" | "low";
  checks: Record<string, boolean>; commitment?: Commitment; task?: TrackerTask; score?: number;
  fingerprint: string;          // (new) one string per finding; comments and audit entries carry it
  proposal?: Proposal;          // (new) the exact write a click or apply mode would make
  rivalScore?: number;          // (new) best competing pairing score, for the card
}

// (new) The write a finding proposes, shown on the card before it is sent.
export type Proposal =
  | { kind: "task"; fileId: string; message: string; assigneeId?: string; assigneeName?: string; due?: string }
  | { kind: "comment"; fileId: string; text: string };

export interface TrackerAdapter {
  listTasks(fileId: string): Promise<TrackerTask[]>;
  createTask(fileId: string, message: string, assigneeId?: string, due?: string): Promise<TrackerTask>;
  // Resolves to the Box comment id, so the audit entry can name it.
  comment(fileId: string, text: string): Promise<string>;
  // (new) True when a comment on the file already carries this fingerprint.
  hasComment(fileId: string, fingerprint: string): Promise<boolean>;
}

// (new) One element of the extraction prompt's JSON, after parsing.
export interface ExtractedItem { kind: "commitment" | "status_change" | "decision" | "idea" | "open_question";
  action: string; owner?: string; due?: string; refersTo?: string;
  newStatus?: "cancelled" | "completed" | "rescheduled" | "reassigned"; evidence: string;
  fileId?: string;              // (new) set by the cycle so set-aside items keep their source
}

export type Trigger = "webhook" | "sweep" | "full_scan" | "click";

// (new) The audit table's fields.
export interface AuditEntry { time: string; trigger: Trigger;
  applied: boolean; change: string; finding: Finding;
  evidence: { quote: string; fileId: string; fileVersion: string };
  model: string; matchScore?: number; outcome: string; }

// (new) The GET /api/state response.
// (new) One finished cycle, for the status strip and the Accuracy page's timing tiles.
export interface CycleRecord { at: string; trigger: Trigger; filesChecked: number;
  filesScanned?: number; aiCalls?: number; durationMs?: number }

// (new) What a running cycle is doing. Files are read in parallel, so the phase is the cycle's.
export interface CycleProgress { done: number; total: number; trigger?: Trigger; startedAt?: string;
  phase?: "files" | "match" | "write"; file?: string }

export interface AppState { mode: "dry-run" | "apply"; watching: boolean;
  lastCycle?: CycleRecord;
  running?: CycleProgress; aiCallsThisMonth: number;
  findings: Finding[]; setAside: ExtractedItem[];
  files?: Record<string, { name: string }>;           // (new) names for card links
  errors?: { fileId: string; message: string }[];      // (new) files the last cycle could not process
  unverified?: (ExtractedItem & { fileId: string })[]; // (new) items dropped by the evidence check
  recentCycles?: Partial<Record<Trigger, CycleRecord>>; // (new) the last cycle of each trigger
  folderName?: string;                                 // (new) the scan folder's name in Box
  waiting?: string[];                                  // (new) finding IDs apply mode leaves for a click
  sweepIntervalMinutes?: number;                       // (new) from config, added by the server
  aiMonthlyBudget?: number;                            // (new) BOX_AI_MONTHLY_BUDGET, when set
}

export interface BoxFile { id: string; name: string; version: string; size: number }
