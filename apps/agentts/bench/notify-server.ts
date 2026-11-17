// Throwaway HTTP server for the notify benchmark (BRA-93).
// Run as its own process: `bun bench/notify-server.ts <port> <hitsFile>`.
// It must NOT live in the bench-runner process — notifyEvent POSTs via
// a blocking curl spawn, so an in-process server could never answer
// while the runner is blocked inside spawnSync (deadlock).
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
