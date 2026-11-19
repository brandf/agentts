// Throwaway HTTP server for the notify benchmark (BRA-93).
// Run as its own process: `bun bench/notify-server.ts <port> <hitsFile>`.
// It stays a separate process so the bench measures the production
// shape (the worker server is its own process). Before BRA-96 there
// was a second reason — notifyEvent POSTed via a blocking curl spawn,
// so an in-process server could never answer while the runner was
// blocked inside spawnSync (deadlock); the POST is an async fetch
// now, so that reason is gone, but the separate process stays.
// Each POST appends one line to <hitsFile>; GET /health returns ok.
import * as fs from "node:fs";

const port = Number(process.argv[2]);
const hitsFile = process.argv[3];
fs.writeFileSync(hitsFile, "");

const server = Bun.serve({
  port,
  fetch(req) {
    if (new URL(req.url).pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    fs.appendFileSync(hitsFile, "hit\n");
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  },
});
console.log(`notify-server listening on ${server.port}`);
