// In-memory working state: findings, review queue, progress. Rebuilt by a full scan after a restart.
import type { AppState, Commitment, ExtractedItem, Finding, Trigger } from "./types.js";
import type { StatusChange } from "./engine/match.js";

export interface FileResult {
  id: string; name: string; version: string; docType: string; docDate?: string; model: string;
  commitments: Commitment[]; statusChanges: StatusChange[];
  setAside: (ExtractedItem & { fileId: string })[];
  unverified: (ExtractedItem & { fileId: string })[];
}

export class State {
  mode: AppState["mode"];
  watching = false;
  lastCycle?: AppState["lastCycle"];
  running?: { done: number; total: number };
  private aiCalls = 0;
  private aiMonth = "";
  files = new Map<string, FileResult>();
  names = new Map<string, string>();
  versions = new Map<string, string>();      // current file_version ID of every listed file
  markers = new Map<string, string>();       // scan markers this process knows, by file ID
  metaMarkers = new Map<string, string>();   // scan markers already written to Box metadata
  metaCounts = new Map<string, string>();    // hcOpenFindings last written to Box, by file ID
  findings: Finding[] = [];
  setAsideCommitments: Commitment[] = [];
  errors: { fileId: string; message: string }[] = [];
  dismissed = new Set<string>();             // fingerprints a person dismissed
  dismissedFiles = new Map<string, string>(); // failed files a person dismissed: file ID to version
  heldLogged = new Set<string>();            // fingerprints already logged as HELD
  writing = new Set<string>();               // fingerprints whose write is in flight
  createdTasks = new Set<string>();          // IDs of tasks this process created in Box

  constructor(mode: AppState["mode"]) { this.mode = mode; }

  countAiCalls(n: number, now: Date): void {
    const month = now.toISOString().slice(0, 7);
    if (month !== this.aiMonth) { this.aiMonth = month; this.aiCalls = 0; }
    this.aiCalls += n;
  }

  get aiCallsThisMonth(): number { return this.aiCalls; }

  finishCycle(at: Date, trigger: Trigger, filesChecked: number): void {
    this.lastCycle = { at: at.toISOString(), trigger, filesChecked };
    this.running = undefined;
  }

  toAppState(): AppState {
    const results = [...this.files.values()];
    const cancelled: ExtractedItem[] = this.setAsideCommitments.map((c) => ({
      kind: "commitment", action: c.text, owner: c.owner, due: c.due, evidence: c.evidence, fileId: c.fileId,
      newStatus: c.status === "cancelled" ? "cancelled" : "completed",
    }));
    // Rescheduled and reassigned updates are not findings. Show them with the other set-asides
    // so a status the matcher does not apply is still visible.
    const otherStatus = results.flatMap((r) => r.statusChanges.filter((s) =>
      s.newStatus !== "cancelled" && s.newStatus !== "completed"));
    return {
      mode: this.mode,
      watching: this.watching,
      lastCycle: this.lastCycle,
      running: this.running,
      aiCallsThisMonth: this.aiCalls,
      findings: this.findings,
      setAside: [...results.flatMap((r) => r.setAside), ...cancelled, ...otherStatus],
      files: Object.fromEntries([...this.names].map(([id, name]) => [id, { name }])),
      errors: this.errors.filter((e) => !this.dismissedFiles.has(e.fileId)),
      unverified: results.flatMap((r) => r.unverified),
    };
  }
}
