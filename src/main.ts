import { dirname, resolve } from "node:path";
import { openDb } from "./db.ts";
import { Router, createApp } from "./http/server.ts";
import { registerApi } from "./http/api.ts";
import { registerPages } from "./http/pages.ts";
import { seed } from "./seed.ts";
import { startWorker } from "./worker.ts";
import { createProviderSet } from "./providers/index.ts";

const dbPath = process.env.VR_DB ?? "vendor-refresh.db";
const db = openDb(dbPath);
const autoSeed = process.env.VR_SEED !== "0";
if (autoSeed) {
  const credFile = dbPath === ":memory:" ? undefined : resolve(dirname(dbPath), "credentials.seed.json");
  seed(db, { credFile });
  if (credFile) console.log(`provisioned credentials written to ${credFile} (mode 600, synthetic local users)`);
}

const providers = createProviderSet(db, {
  rail: process.env.VR_RAIL ?? "local-emulator",
});

const router = new Router();
registerApi(router);
registerPages(router, providers);

const port = Number(process.env.VR_PORT ?? 8080); // VR_PORT=0 -> ephemeral, announced below
const host = process.env.VR_HOST; // e.g. 127.0.0.1 to bind loopback only
const server = createApp(db, router);
const announce = () => {
  const a = server.address();
  const shown = a && typeof a === "object" ? `${a.address}:${a.port}` : `${host ?? "localhost"}:${port}`;
  console.log(`vendor-refresh api+web listening on http://${shown}`);
};
if (host) server.listen(port, host, announce);
else server.listen(port, announce);

const worker = startWorker(db, providers, { intervalMs: Number(process.env.VR_WORKER_MS ?? 250) });
console.log(`worker started (rail=${providers.railName})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    worker.stop();
    server.close();
    process.exit(0);
  });
}
