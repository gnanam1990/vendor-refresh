import { openDb } from "./db.ts";
import { Router, createApp } from "./http/server.ts";
import { registerApi } from "./http/api.ts";
import { registerPages } from "./http/pages.ts";
import { seed } from "./seed.ts";
import { startWorker } from "./worker.ts";
import { createProviderSet } from "./providers/index.ts";

const db = openDb(process.env.VR_DB ?? "vendor-refresh.db");
const autoSeed = process.env.VR_SEED !== "0";
if (autoSeed) seed(db);

const providers = createProviderSet(db, {
  rail: process.env.VR_RAIL ?? "local-emulator",
});

const router = new Router();
registerApi(router);
registerPages(router, providers);

const port = Number(process.env.VR_PORT ?? 8080);
const server = createApp(db, router);
server.listen(port, () => {
  console.log(`vendor-refresh api+web listening on http://localhost:${port}`);
});

const worker = startWorker(db, providers, { intervalMs: Number(process.env.VR_WORKER_MS ?? 250) });
console.log(`worker started (rail=${providers.railName})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    worker.stop();
    server.close();
    process.exit(0);
  });
}
