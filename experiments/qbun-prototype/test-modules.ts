// qbun module smoke test: node:fs, node:child_process, Bun.file/Bun.write, fetch.
// Every check has a real observable effect; the script prints PROOF lines.
import { writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

writeFileSync("/tmp/qbun-test-fs.txt", "hello fs\n");
console.log("fs read:", JSON.stringify(readFileSync("/tmp/qbun-test-fs.txt", "utf8")));

await Bun.write("/tmp/qbun-test-bun.txt", "hello bun\n");
console.log("bun read:", JSON.stringify(await Bun.file("/tmp/qbun-test-bun.txt").text()));

console.log("child_process:", JSON.stringify(execSync("echo child-process-works").toString().trim()));

const res = await fetch("https://example.com");
const body = await res.text();
console.log("fetch:", res.status, JSON.stringify(body.slice(0, 80)));
console.log("MODULES OK");
