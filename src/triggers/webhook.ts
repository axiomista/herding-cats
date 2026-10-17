// Box webhook: signature check and queue. The handler only queues file IDs, so a forged request
// that got through would trigger a scan, not a write.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { CycleRunner } from "../engine/cycle.js";

export const MAX_AGE_MS = 10 * 60 * 1000;

export function signBody(body: Buffer | string, timestamp: string, key: string): string {
  return createHmac("sha256", key).update(Buffer.concat([Buffer.from(body), Buffer.from(timestamp)])).digest("base64");
}

const equal = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// Valid when the primary or secondary signature matches its key and the delivery timestamp is
// within 10 minutes.
export function verifyBoxSignature(body: Buffer, headers: Record<string, string | string[] | undefined>,
  keys: { primary: string; secondary: string }, now = new Date()): boolean {
  const header = (name: string) => { const v = headers[name]; return Array.isArray(v) ? v[0] : v; };
  const timestamp = header("box-delivery-timestamp");
  if (!timestamp) return false;
  const sent = Date.parse(timestamp);
  if (Number.isNaN(sent) || Math.abs(now.getTime() - sent) > MAX_AGE_MS) return false;
  const primary = header("box-signature-primary");
  const secondary = header("box-signature-secondary");
  return (!!primary && !!keys.primary && equal(primary, signBody(body, timestamp, keys.primary)))
    || (!!secondary && !!keys.secondary && equal(secondary, signBody(body, timestamp, keys.secondary)));
}

interface BoxEvent {
  id?: string;
  trigger?: string;
  source?: { id?: string; type?: string; item?: { id?: string; type?: string } };
  created_by?: { id?: string };
}

// The uploaded file, or the file the task sits on.
export function fileIdsFromEvent(event: BoxEvent): string[] {
  const s = event.source;
  if (!s) return [];
  if (s.type === "file" && s.id) return [s.id];
  if (s.item?.type === "file" && s.item.id) return [s.item.id];
  return [];
}

export function createWebhookHandler(opts: {
  keys: { primary: string; secondary: string };
  runner: Pick<CycleRunner, "enqueue">;
  serviceUserId: () => Promise<string>;
  now?: () => Date;
}) {
  const seen = new Set<string>();
  return async (req: Request, res: Response) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    if (!verifyBoxSignature(body, req.headers, opts.keys, opts.now?.())) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    let event: BoxEvent;
    try { event = JSON.parse(body.toString("utf8")); } catch { res.status(400).json({ error: "invalid JSON" }); return; }
    const deliveryId = String(req.headers["box-delivery-id"] ?? "");
    const eventId = event.id ?? deliveryId;
    if (eventId && seen.has(eventId)) { res.status(200).json({ queued: 0, duplicate: true }); return; }
    if (eventId) seen.add(eventId);
    if (event.created_by?.id && event.created_by.id === await opts.serviceUserId().catch(() => "")) {
      res.status(200).json({ queued: 0, ignored: "own event" });
      return;
    }
    const ids = fileIdsFromEvent(event);
    if (ids.length) opts.runner.enqueue(ids, "webhook");
    res.status(200).json({ queued: ids.length });
  };
}
