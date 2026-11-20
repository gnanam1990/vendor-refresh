import type { DB } from "./db.ts";
import { now, openDb } from "./db.ts";
import { processOutboxRow } from "./services/pipeline.ts";
import { createProviderSet, type ProviderSet } from "./providers/index.ts";

/**
 * Supervised outbox worker: drains pending rows, marks attempts, retries
 * transient failures with backoff, and never holds a browser session.
 */
export function startWorker(db: DB, providers: ProviderSet, opts: { intervalMs?: number } = {}) {
  const intervalMs = opts.intervalMs ?? 250;
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    drain(db, providers).catch((e) => console.error("worker drain error", e)).finally(() => (running = false));
  }, intervalMs);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    get stopped() {
      return stopped;
    },
  };
}

export async function drain(db: DB, providers: ProviderSet, limit = 50): Promise<number> {
  const rows = db
    .prepare("SELECT * FROM outbox WHERE state = 'pending' AND next_at <= ? ORDER BY created_at LIMIT ?")
    .all(now(), limit) as Record<string, unknown>[];
  let done = 0;
  for (const row of rows) {
    try {
      await processOutboxRow(db, providers, row);
      db.prepare("UPDATE outbox SET state = 'done', updated_at = ? WHERE id = ?").run(now(), row.id);
      done++;
    } catch (e) {
      const attempts = Number(row.attempts) + 1;
      const dead = attempts >= 8;
      const backoff = Math.min(300_000, 1000 * 2 ** attempts);
      db.prepare("UPDATE outbox SET attempts = ?, state = ?, next_at = ?, updated_at = ? WHERE id = ?").run(
        attempts,
        dead ? "dead" : "pending",
        new Date(Date.now() + backoff).toISOString(),
        now(),
        row.id
      );
      console.error(`outbox ${row.id} (${row.kind}) attempt ${attempts} failed:`, (e as Error).message);
    }
  }
  return done;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb(process.env.VR_DB ?? "vendor-refresh.db");
  const providers = createProviderSet(db, { rail: process.env.VR_RAIL ?? "local-emulator" });
  startWorker(db, providers, { intervalMs: Number(process.env.VR_WORKER_MS ?? 250) });
  console.log("worker only mode");
}
