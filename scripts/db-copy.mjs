#!/usr/bin/env node
// Copies the live Supabase database into a second Supabase project and re-keys
// it for developers. Kev only. Inputs, steps and limits: docs/DEV-ENV.md.
//
//   node scripts/db-copy.mjs --dev-env .env.dev.local [--name enki-dev] [--dry-run] [--reset] [--skip-data]
//
// Every step and guard lives in lib/dev/db-copy.ts; this file supplies the real
// file system, child processes and network. Secrets travel in memory and in the
// child environment (PGPASSWORD), never on a command line or in a log line.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { runDbCopy } from "../lib/dev/db-copy.ts";

const run = (command, args, extraEnv) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

const which = (command) => {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [command], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() || null : null;
};

const download = async (url, dest) => {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download of ${url} answered ${res.status}.`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
};

const sha256File = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

runDbCopy(process.argv.slice(2), {
  fetch,
  run,
  which,
  download,
  readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
  writeFile: (p, text) => writeFileSync(p, text, { mode: 0o600 }),
  remove: (p) => rmSync(p, { recursive: true, force: true }),
  sha256File,
  exists: existsSync,
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  tmpdir: tmpdir().replace(/\\/g, "/"),
  platform: process.platform,
  log: (line) => console.log(line),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  randomBytes,
  now: Date.now,
}).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
});
