#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_SCRIPTS = dirname(fileURLToPath(import.meta.url));

const RUST_GATES = [
  ["Rustfmt", "cargo", ["fmt", "--all", "--", "--check"]],
  ["Clippy", "cargo", ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"]],
  ["Architecture", "node", [resolve(SKILL_SCRIPTS, "check-architecture-rust.mjs")]],
];

function resolveTargetDir() {
  const explicit = process.argv.find((arg) => arg.startsWith("--cwd="));
  if (explicit) return resolve(explicit.slice("--cwd=".length));

  const cwd = process.cwd();
  const candidates = [cwd, resolve(cwd, "apps/backend"), resolve(cwd, "backend")];
  return candidates.find((dir) => looksLikeRustProject(dir)) ?? cwd;
}

function looksLikeRustProject(dir) {
  if (!existsSync(resolve(dir, "Cargo.toml"))) return false;
  return existsSync(resolve(dir, "crates/domain")) || existsSync(resolve(dir, "src/domain"));
}

function commandLine(command, args) {
  return [command, ...args].join(" ");
}

function runGate(targetDir, [name, command, args]) {
  console.log(`\n[clean-arch:gates] ${name}: ${commandLine(command, args)}`);
  const result = spawnSync(command, args, {
    cwd: targetDir,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[clean-arch:gates] ${name} failed to start: ${result.error.message}`);
  }
  return { name, status: result.status ?? 1 };
}

function summarize(results) {
  const failed = results.filter((result) => result.status !== 0);
  if (failed.length === 0) {
    console.log("\n[clean-arch:gates] All gates passed.");
    return 0;
  }

  console.error("\n[clean-arch:gates] Failed gates:");
  for (const result of failed) {
    console.error(`  - ${result.name} exited ${result.status}`);
  }
  return 1;
}

const targetDir = resolveTargetDir();
console.log(`[clean-arch:gates] cwd: ${targetDir}`);
if (!looksLikeRustProject(targetDir)) {
  console.error(
    "[clean-arch:gates] No Rust backend found: expected a Cargo.toml next to crates/domain or src/domain " +
      "(in the cwd, apps/backend or backend). Run from the backend root or pass --cwd=<backend-path>.",
  );
  process.exitCode = 1;
} else {
  process.exitCode = summarize(RUST_GATES.map((gate) => runGate(targetDir, gate)));
}
