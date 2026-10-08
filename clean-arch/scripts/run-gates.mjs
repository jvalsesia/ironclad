#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const SKILL_SCRIPTS = dirname(fileURLToPath(import.meta.url));

const TYPESCRIPT_GATES = [
  ["TypeScript", NPX, ["tsc", "--noEmit", "-p", "tsconfig.json"]],
  ["ESLint", NPX, ["eslint", ".", "--max-warnings=0"]],
  ["Dependency Cruiser", NPX, ["depcruise", "src", "--config", ".dependency-cruiser.cjs"]],
  ["Architecture", NPX, ["tsx", "scripts/check-architecture.ts"]],
  ["Madge", NPX, ["madge", "--circular", "--extensions", "ts", "--json", "src"]],
  ["Knip", NPX, ["knip"]],
];

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
  return candidates.find((dir) => looksLikeCleanArchProject(dir) || looksLikeRustProject(dir)) ?? cwd;
}

function looksLikeCleanArchProject(dir) {
  return existsSync(resolve(dir, "src")) && existsSync(resolve(dir, "tsconfig.json"));
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
  if (name === "Madge") return runMadgeGate(targetDir, name, command, args);

  const result = spawnSync(command, args, {
    cwd: targetDir,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[clean-arch:gates] ${name} failed to start: ${result.error.message}`);
  }
  return { name, status: result.status ?? 1 };
}

function runMadgeGate(targetDir, name, command, args) {
  const result = spawnSync(command, args, {
    cwd: targetDir,
    encoding: "utf8",
  });
  if (result.error) {
    console.error(`[clean-arch:gates] ${name} failed to start: ${result.error.message}`);
    return { name, status: 1 };
  }
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    return { name, status: result.status ?? 1 };
  }

  const cycles = parseMadgeCycles(result.stdout, name);
  if (!cycles) return { name, status: 1 };
  if (cycles.length === 0) {
    console.log("✓ madge: no circular dependency found");
    return { name, status: 0 };
  }

  console.error("[clean-arch:gates] Circular dependencies found:");
  for (const cycle of cycles) console.error(`  - ${cycle.join(" -> ")}`);
  return { name, status: 1 };
}

function parseMadgeCycles(output, gateName) {
  try {
    const parsed = JSON.parse(output.trim() || "[]");
    if (Array.isArray(parsed)) return parsed;
  } catch (error) {
    console.error(`[clean-arch:gates] ${gateName} returned invalid JSON: ${error.message}`);
    return null;
  }
  console.error(`[clean-arch:gates] ${gateName} returned an unexpected JSON shape.`);
  return null;
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
const gates = looksLikeRustProject(targetDir) ? RUST_GATES : TYPESCRIPT_GATES;
console.log(`[clean-arch:gates] cwd: ${targetDir}`);
process.exitCode = summarize(gates.map((gate) => runGate(targetDir, gate)));
