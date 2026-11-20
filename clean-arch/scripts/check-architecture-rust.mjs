#!/usr/bin/env node
/**
 * Architecture fitness function for Rust backends — the structural gate of the
 * self-audit.
 *
 * Checks what rustc, clippy and Cargo cannot express: which crates a layer may
 * depend on, file naming per location, the shape of use cases, entities, value
 * objects and handlers, in-memory fake presence, the shared whitelist, etc.
 *
 * Run with:  node check-architecture-rust.mjs [--cwd=<backend-root>]
 *
 * Supports both layouts described in references/architecture/workspace-layout.md:
 *   - workspace:     crates/{domain,usecase,infra,app}/src
 *   - single crate:  src/{domain,usecase,infra} + src/config.rs + src/main.rs
 *
 * Dependency-free (node: builtins only). Exits non-zero on any violation.
 *
 * The checks mirror `SKILL.md` and `references/architecture/`. When
 * changing the architecture, update this script and those documents together.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Crates that perform I/O. Forbidden in `domain` and `usecase`, both as a
// Cargo dependency and as a path in source.
const IO_CRATES = [
  'sqlx', 'diesel', 'sea-orm', 'tokio-postgres', 'rusqlite', 'mongodb', 'redis',
  'axum', 'actix-web', 'warp', 'rocket', 'hyper', 'tower', 'tower-http',
  'reqwest', 'ureq', 'tokio',
  // message brokers (references/architecture/messaging.md)
  'rdkafka', 'lapin', 'async-nats', 'aws-sdk-sqs', 'aws-sdk-sns', 'aws-config',
];
const IO_STD_MODULES = ['std::fs', 'std::net', 'std::process', 'std::env'];

const SHARED_WHITELIST = new Set([
  'mod.rs', 'id.rs', 'errors.rs', 'pagination.rs', 'unit_of_work.rs',
  'event.rs', // opt-in, when domain events are adopted
]);
const USECASE_FORBIDDEN_FOLDERS = new Set([
  'shared', '_shared', 'common', 'cross', 'multi', 'utils', 'helpers',
]);
const ERROR_STATUSES =
  /StatusCode::(BAD_REQUEST|UNAUTHORIZED|FORBIDDEN|NOT_FOUND|CONFLICT|UNPROCESSABLE_ENTITY|INTERNAL_SERVER_ERROR)/;

// Rule 19: a gate is fixed, never silenced. `#![expect(..)]` (config.rs) stays allowed.
const SILENCED_LINT = /#!?\[\s*(?:allow\s*\(|rustfmt::skip\b|cfg_attr\s*\([^\]]*?\ballow\s*\()/;
// Shared mutable state belongs inside an infra adapter, never in domain / usecase.
const INTERIOR_MUTABILITY =
  /\b(?:Rc|RefCell|Cell|Mutex|RwLock|OnceCell)\s*<|\b(?:std|core|alloc)::(?:rc::Rc|cell::(?:RefCell|Cell|OnceCell)|sync::(?:Mutex|RwLock))\b/;
// Global mutable state or a global dependency (rule 11). A static `LazyLock<Regex>` is fine.
const GLOBAL_STATE = [
  [/\bstatic\s+mut\b/, '`static mut`'],
  [/\blazy_static\s*!/, '`lazy_static!`'],
  [/\bthread_local\s*!/, '`thread_local!`'],
  [/\bstatic\s+\w+\s*:\s*(?:[\w:]*::)?(?:Mutex|RwLock)\s*</, 'a `static` lock'],
  [/\bstatic\s+\w+\s*:\s*(?:[\w:]*::)?(?:OnceLock|OnceCell|LazyLock|Lazy)\s*<[^;=]*?(?:Config|Settings|Pool|Client|Connection|Mutex|RwLock)/,
    'a `static` holding a config, pool, client or lock'],
];

const SNAKE = /^[a-z][a-z0-9_]*$/;
const norm = (crateName) => crateName.replace(/-/g, '_');
const posix = (p) => p.replace(/\\/g, '/');

// ── File helpers ────────────────────────────────────────────────────────────

const isDir = (p) => existsSync(p) && statSync(p).isDirectory();

const walk = (dir) => {
  if (!isDir(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
};

const subdirs = (dir) =>
  isDir(dir) ? readdirSync(dir).sort().filter((n) => isDir(join(dir, n))) : [];

const rustFilesIn = (dir) =>
  isDir(dir)
    ? readdirSync(dir).sort().filter((n) => n.endsWith('.rs') && !isDir(join(dir, n)))
    : [];

/** Removes comments so they cannot trigger (or hide) a rule. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * Production code only: comments removed and everything from the first
 * `#[cfg(test)]` on dropped. Convention: the test module is the last item.
 */
const productionCode = (file) => {
  const src = stripComments(readFileSync(file, 'utf8'));
  const at = src.indexOf('#[cfg(test)]');
  return at === -1 ? src : src.slice(0, at);
};

// ── Layout detection ────────────────────────────────────────────────────────

const detectLayout = (root) => {
  const crates = join(root, 'crates');
  if (['domain', 'usecase', 'infra'].every((c) => isDir(join(crates, c, 'src')))) {
    return {
      kind: 'workspace',
      domain: join(crates, 'domain', 'src'),
      usecase: join(crates, 'usecase', 'src'),
      infra: join(crates, 'infra', 'src'),
      config: join(crates, 'app', 'src', 'config.rs'),
      sources: walk(crates).filter((f) => f.endsWith('.rs') && posix(f).includes('/src/')),
    };
  }
  const src = join(root, 'src');
  if (['domain', 'usecase', 'infra'].every((l) => isDir(join(src, l)))) {
    return {
      kind: 'single-crate',
      domain: join(src, 'domain'),
      usecase: join(src, 'usecase'),
      infra: join(src, 'infra'),
      config: join(src, 'config.rs'),
      sources: walk(src).filter((f) => f.endsWith('.rs')),
    };
  }
  return null;
};

// ── Cargo.toml helpers (workspace layout) ───────────────────────────────────

const packageName = (manifest) => {
  const section = /\[package\]([\s\S]*?)(?=\n\[|$)/.exec(readFileSync(manifest, 'utf8'));
  const name = section && /^\s*name\s*=\s*"([^"]+)"/m.exec(section[1]);
  return name ? name[1] : null;
};

/** Keys of `[dependencies]` (incl. target-specific); dev/build deps are exempt. */
const dependencyNames = (manifest) => {
  const names = new Set();
  let inDeps = false;
  for (const raw of readFileSync(manifest, 'utf8').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const section = header[1].trim();
      const table = /(?:^|\.)dependencies\.([A-Za-z0-9_-]+)$/.exec(section);
      if (table) names.add(table[1]); // [dependencies.name]
      inDeps = /(?:^|\.)dependencies$/.test(section);
      continue;
    }
    if (!inDeps) continue;
    const key = /^([A-Za-z0-9_-]+)\s*(?:\.|=)/.exec(line);
    if (key) names.add(key[1]);
  }
  return names;
};

// ── The check ───────────────────────────────────────────────────────────────

export function checkArchitecture(rootDir) {
  const root = resolve(rootDir);
  const violations = [];
  const report = (file, rule, message) =>
    violations.push({ file: posix(relative(root, file)) || '.', rule, message });

  const layout = detectLayout(root);
  if (!layout) {
    report(root, 'layout', 'No clean-arch Rust layout found. Expected crates/{domain,usecase,infra}/src (workspace) or src/{domain,usecase,infra} (single crate).');
    return { layout: null, violations };
  }
  const { domain, usecase, infra } = layout;
  const inLayer = (file, layerRoot) => posix(file).startsWith(posix(layerRoot) + '/');
  const layerFiles = (layerRoot) => layout.sources.filter((f) => inLayer(f, layerRoot));

  // ── Rule: a crate depends only on the layers inside it (workspace) ────────
  if (layout.kind === 'workspace') {
    const crate = (name) => join(root, 'crates', name, 'Cargo.toml');
    const nameOf = Object.fromEntries(
      ['domain', 'usecase', 'infra', 'app']
        .filter((c) => existsSync(crate(c)))
        .map((c) => [c, norm(packageName(crate(c)) ?? c)]),
    );
    const FORBIDDEN = { domain: ['usecase', 'infra', 'app'], usecase: ['infra', 'app'], infra: ['app'] };
    for (const [layer, outer] of Object.entries(FORBIDDEN)) {
      const deps = [...dependencyNames(crate(layer))].map(norm);
      for (const target of outer) {
        if (nameOf[target] && deps.includes(nameOf[target])) {
          report(crate(layer), 'crate-deps', `\`${layer}\` must not depend on \`${target}\`. Dependencies point inward only.`);
        }
      }
      if (deps.includes('anyhow')) {
        report(crate(layer), 'anyhow-only-in-app', `\`${layer}\` must not depend on \`anyhow\`. Use typed errors (\`AppError\`, feature enums); \`anyhow\` belongs to \`app\` only.`);
      }
      if (layer === 'infra') continue;
      for (const io of IO_CRATES) {
        if (deps.includes(norm(io))) {
          report(crate(layer), 'forbidden-crate', `\`${layer}\` must not depend on the I/O crate \`${io}\`. Move the code to \`infra\` behind a trait.`);
        }
      }
    }
  }

  // ── Rule: no I/O in domain / usecase source ────────────────────────────────
  {
    const ioPath = new RegExp(`(?<![A-Za-z0-9_:])(${IO_CRATES.map(norm).join('|')})::`);
    for (const [layer, layerRoot] of [['domain', domain], ['usecase', usecase]]) {
      for (const file of layerFiles(layerRoot)) {
        const src = productionCode(file);
        const crateHit = ioPath.exec(src);
        if (crateHit) {
          report(file, 'forbidden-crate', `\`${layer}\` must not use the I/O crate \`${crateHit[1]}\`.`);
        }
        const stdHit = IO_STD_MODULES.find((m) => src.includes(m));
        if (stdHit) {
          report(file, 'forbidden-crate', `\`${layer}\` must not use \`${stdHit}\`. I/O belongs to \`infra\`.`);
        }
      }
    }
  }

  // ── Rule: imports point inward (single crate; Cargo enforces it otherwise) ─
  if (layout.kind === 'single-crate') {
    const FORBIDDEN = [
      ['domain', domain, ['crate::usecase', 'crate::infra', 'crate::config']],
      ['usecase', usecase, ['crate::infra', 'crate::config']],
    ];
    for (const [layer, layerRoot, targets] of FORBIDDEN) {
      for (const file of layerFiles(layerRoot)) {
        const src = productionCode(file);
        const hit = targets.find((t) => new RegExp(`\\b${t}\\b`).test(src));
        if (hit) report(file, 'layer-import', `\`${layer}\` must not reference \`${hit}\`. Dependencies point inward only.`);
      }
    }
  }

  // ── Rule: the environment is read only in the config module ───────────────
  {
    const ENV = /\benv::(var|var_os|vars|vars_os)\s*\(|\b(dotenvy|dotenv)::/;
    for (const file of layout.sources) {
      if (resolve(file) === resolve(layout.config)) continue;
      if (ENV.test(productionCode(file))) {
        report(file, 'env-outside-config', `Read the environment only in ${posix(relative(root, layout.config))}; pass values in through constructors.`);
      }
    }
  }

  // ── Rule: no silenced lints, no global state (all production code) ─────────
  for (const file of layout.sources) {
    const src = productionCode(file);
    if (SILENCED_LINT.test(src)) {
      report(file, 'no-silenced-lint', 'Do not silence a gate with `#[allow(..)]` or `#[rustfmt::skip]` (rule 19). Fix the code; if the gate seems wrong, ask.');
    }
    const global = GLOBAL_STATE.find(([rx]) => rx.test(src));
    if (global) {
      report(file, 'no-global-state', `Global state (${global[1]}). Build dependencies in the composition root and pass them through constructors (rule 11).`);
    }
  }

  // ── Rule: anyhow only in the binary (source; the manifest is checked above) ─
  for (const [layer, layerRoot] of [['domain', domain], ['usecase', usecase], ['infra', infra]]) {
    for (const file of layerFiles(layerRoot)) {
      if (/(?<![A-Za-z0-9_:])anyhow(?:::|!)/.test(productionCode(file))) {
        report(file, 'anyhow-only-in-app', `\`${layer}\` must not use \`anyhow\`. Return typed errors (\`AppError\`, feature enums); \`anyhow\` belongs to \`app\` only.`);
      }
    }
  }

  // ── Rule: no interior mutability in domain / usecase ───────────────────────
  for (const [layer, layerRoot] of [['domain', domain], ['usecase', usecase]]) {
    for (const file of layerFiles(layerRoot)) {
      if (INTERIOR_MUTABILITY.test(productionCode(file))) {
        report(file, 'no-interior-mutability', `\`${layer}\` must not use Rc / RefCell / Cell / Mutex / RwLock. Mutate through \`&mut self\`; shared state lives inside an infra adapter behind a port.`);
      }
    }
  }

  // ── Rule: snake_case files and folders ─────────────────────────────────────
  for (const layerRoot of [domain, usecase, infra]) {
    for (const file of walk(layerRoot)) {
      const segments = posix(relative(layerRoot, file)).split('/');
      const fileName = segments.pop();
      const badDir = segments.find((s) => !SNAKE.test(s));
      if (badDir) report(file, 'snake-case', `Folder "${badDir}" must be snake_case.`);
      if (fileName.endsWith('.rs') && !SNAKE.test(fileName.slice(0, -3))) {
        report(file, 'snake-case', `File "${fileName}" must be snake_case.`);
      }
    }
  }

  // ── Rule: mod.rs / lib.rs are facades (declarations and named re-exports) ──
  {
    const MOD_DECL = /^(#!?\[[^\]]*\]\s*)*(pub(\([a-z ]+\))?\s+)?mod\s+\w+$/;
    const RE_EXPORT = /^(#!?\[[^\]]*\]\s*)*pub(\([a-z ]+\))?\s+use\s+[^*]+$/;
    const ATTRS_ONLY = /^(#!?\[[^\]]*\]\s*)*$/;
    for (const layerRoot of [domain, usecase, infra]) {
      for (const file of walk(layerRoot)) {
        if (!['mod.rs', 'lib.rs'].includes(basename(file))) continue;
        const statements = stripComments(readFileSync(file, 'utf8'))
          .split(';')
          .map((s) => s.replace(/\s+/g, ' ').trim());
        for (const statement of statements) {
          if (ATTRS_ONLY.test(statement) || MOD_DECL.test(statement) || RE_EXPORT.test(statement)) continue;
          if (/\buse\b[^;]*\*/.test(statement)) {
            report(file, 'mod-facade', 'Glob re-export. Re-export by name so the public surface of the module is explicit.');
          } else {
            report(file, 'mod-facade', `${basename(file)} may only declare modules and re-export by name. Move this into its own file: "${statement.slice(0, 60)}"`);
          }
          break; // one finding per file is enough
        }
      }
    }
  }

  // ── Rule: domain/shared whitelist ──────────────────────────────────────────
  {
    const shared = join(domain, 'shared');
    for (const file of walk(shared)) {
      const name = posix(relative(shared, file));
      if (!SHARED_WHITELIST.has(name)) {
        report(file, 'shared-whitelist', `domain/shared accepts only ${[...SHARED_WHITELIST].join(', ')}. Move "${name}" to a feature.`);
      }
    }
  }

  // ── Rule: features are folders; files are named by what they are ───────────
  {
    const checkDir = (dir, allowed, description) => {
      for (const name of rustFilesIn(dir)) {
        if (name === 'mod.rs') continue;
        if (!allowed.some((rx) => rx.test(name))) {
          report(join(dir, name), 'naming-suffix', `Unexpected file. Allowed here: ${description}.`);
        }
      }
    };
    const rootFile = (layerRoot, layer) => {
      for (const name of rustFilesIn(layerRoot)) {
        if (name !== 'lib.rs' && name !== 'mod.rs') {
          report(join(layerRoot, name), 'naming-suffix', `${layer}/ holds feature folders only. Move "${name}" into its feature.`);
        }
      }
    };

    rootFile(domain, 'domain');
    for (const feature of subdirs(domain).filter((d) => d !== 'shared')) {
      checkDir(
        join(domain, feature),
        [/_entity\.rs$/, /_vo\.rs$/, /_repository\.rs$/, /_queries\.rs$/, /_gateway\.rs$/, /_publisher\.rs$/, /^errors\.rs$/, /^events\.rs$/],
        '*_entity.rs, *_vo.rs, *_repository.rs, *_queries.rs, *_gateway.rs, *_publisher.rs, errors.rs, events.rs',
      );
    }

    rootFile(usecase, 'usecase');
    for (const feature of subdirs(usecase)) {
      if (USECASE_FORBIDDEN_FOLDERS.has(feature)) {
        report(join(usecase, feature), 'usecase-forbidden-folder', `usecase/${feature}/ is forbidden. Put the use case in the primary aggregate's folder, or in a named composite-flow folder (e.g. user_onboarding/).`);
      }
    }

    for (const feature of subdirs(join(infra, 'repository'))) {
      checkDir(join(infra, 'repository', feature), [/_repository\.rs$/, /_row\.rs$/], '<provider>_<feature>_repository.rs, in_memory_<feature>_repository.rs, *_row.rs');
    }
    for (const feature of subdirs(join(infra, 'queries'))) {
      checkDir(join(infra, 'queries', feature), [/_queries\.rs$/, /_row\.rs$/], '<provider>_<feature>_queries.rs, in_memory_<feature>_queries.rs, *_row.rs');
    }
    for (const feature of subdirs(join(infra, 'http')).filter((d) => d !== 'middleware')) {
      checkDir(join(infra, 'http', feature), [/_handler\.rs$/, /_routes\.rs$/], '*_handler.rs, *_routes.rs');
    }
    checkDir(join(infra, 'gateway'), [/_gateway\.rs$/], '<provider>_<concept>_gateway.rs');
    // infra/messaging/ root holds broker plumbing (producers, subscribers, relay); features are checked.
    for (const feature of subdirs(join(infra, 'messaging'))) {
      checkDir(join(infra, 'messaging', feature), [/_publisher\.rs$/, /_consumer\.rs$/, /_message\.rs$/], '*_publisher.rs, in_memory_*_publisher.rs, *_consumer.rs, <feature>_message.rs');
    }
  }

  // ── Rule: every event publisher implementation has an in-memory fake ───────
  for (const feature of subdirs(join(infra, 'messaging'))) {
    const dir = join(infra, 'messaging', feature);
    const impls = rustFilesIn(dir).filter((n) => n.endsWith('_publisher.rs'));
    const real = impls.filter((n) => !n.startsWith('in_memory_'));
    if (real.length > 0 && real.length === impls.length) {
      report(join(dir, real[0]), 'missing-in-memory-publisher', `Missing fake: in_memory_${feature}_event_publisher.rs next to it. Every implementation needs an in-memory counterpart.`);
    }
  }

  // ── Rule: every repository / queries implementation has an in-memory fake ──
  for (const [kind, suffix] of [['repository', '_repository.rs'], ['queries', '_queries.rs']]) {
    for (const feature of subdirs(join(infra, kind))) {
      const dir = join(infra, kind, feature);
      const impls = rustFilesIn(dir).filter((n) => n.endsWith(suffix));
      const real = impls.filter((n) => !n.startsWith('in_memory_'));
      if (real.length > 0 && real.length === impls.length) {
        report(join(dir, real[0]), `missing-in-memory-${kind === 'repository' ? 'repo' : 'queries'}`, `Missing fake: in_memory_${feature}${suffix} next to it. Every implementation needs an in-memory counterpart.`);
      }
    }
  }

  // ── Rule: one use case per file, one public method `execute` ───────────────
  for (const feature of subdirs(usecase)) {
    for (const name of rustFilesIn(join(usecase, feature))) {
      if (name === 'mod.rs') continue;
      const file = join(usecase, feature, name);
      const src = productionCode(file);
      const structs = [...src.matchAll(/\bpub\s+struct\s+(\w+UseCase)\b/g)].map((m) => m[1]);
      if (structs.length !== 1) {
        report(file, 'usecase-shape', `A use case file declares exactly one \`pub struct <Action><Feature>UseCase\`. Found: [${structs.join(', ') || 'none'}].`);
      }
      const fns = [...src.matchAll(/\bpub\s+(?:const\s+)?(?:async\s+)?fn\s+(\w+)/g)].map((m) => m[1]);
      const extra = fns.filter((f) => f !== 'new' && f !== 'execute');
      if (!fns.includes('execute') || extra.length > 0) {
        report(file, 'usecase-single-execute', `A use case exposes \`new\` and exactly one public method \`execute\`. Found: [${fns.join(', ') || 'none'}].`);
      }
      if (/^(list|search)_/.test(name) && !/\bPageInput\b/.test(src)) {
        report(file, 'list-page-input', 'List/Search use case input must carry `PageInput`.');
      }
      if (/\bpub\s+struct\s+\w+UseCase\s*</.test(src)) {
        report(file, 'usecase-generic-ports', 'A use case is not generic over its ports. Hold `Arc<dyn Port>` fields so handlers never name the adapter.');
      }
      if (/\bfn\s+execute\s*(?:<[^>]*>)?\s*\(\s*&\s*(?:'\w+\s+)?mut\s+self\b/.test(src)) {
        report(file, 'usecase-stateless', 'A use case is stateless and shared as `Arc<UseCase>`: `execute(&self, input)`, never `&mut self`.');
      }
      const others = [...new Set([...src.matchAll(/\b(\w+UseCase)\b/g)].map((m) => m[1]))].filter((n) => !structs.includes(n));
      if (others.length > 0) {
        report(file, 'usecase-no-composition', `Use cases do not compose (found ${others.join(', ')}). Move shared logic into the domain or behind a port.`);
      }
    }
  }

  // ── Rule: entities and value objects are closed (domain) ───────────────────
  {
    const publicField = (src) =>
      [...src.matchAll(/\bpub\s+struct\s+\w+[^;{(]*\{([\s\S]*?)\n\}/g)].some((m) => /^\s*pub(\([a-z ]+\))?\s+\w+\s*:/m.test(m[1])) ||
      /\bpub\s+struct\s+\w+[^;{(]*\(\s*pub\b/.test(src);
    const serde = (src) => /derive\s*\([^)]*\b(Serialize|Deserialize)\b/.test(src);
    const has = (src, fn) => new RegExp(`\\bpub\\s+(?:const\\s+)?fn\\s+${fn}\\s*[<(]`).test(src);

    for (const file of layerFiles(domain)) {
      const name = basename(file);
      const src = productionCode(file);
      if (/\bpub\s+(?:const\s+)?fn\s+set_\w+/.test(src)) {
        report(file, 'no-setters-in-domain', 'domain may not expose `set_*` methods. Use a method named after the business operation.');
      }
      if (/\bimpl\s*(?:<[^>]*>\s*)?(?:[\w:]*::)?Deref(?:Mut)?\s+for\b/.test(src)) {
        report(file, 'no-deref-in-domain', 'Domain types do not implement Deref / DerefMut: it re-exposes the inner type\'s whole API. Add an accessor (`as_str`, `value`).');
      }
      if ((name.endsWith('_entity.rs') || name.endsWith('_vo.rs')) &&
          (/derive\s*\([^)]*\bDefault\b/.test(src) || /\bimpl\s*(?:<[^>]*>\s*)?(?:[\w:]*::)?Default\s+for\b/.test(src))) {
        report(file, 'no-default-entity-vo', 'Entities and value objects never implement Default: a default entity skipped `create`, a default value object skipped validation.');
      }
      if (name.endsWith('_entity.rs')) {
        if (publicField(src)) report(file, 'entity-private-fields', 'Entity fields must be private; expose read-only getters.');
        if (!has(src, 'create')) report(file, 'entity-create-factory', 'Entity must define `pub fn create(...)`.');
        if (!has(src, 'restore')) report(file, 'entity-restore-factory', 'Entity must define `pub fn restore(...)` for rehydration from persistence.');
        if (serde(src)) report(file, 'entity-not-serializable', 'Entities never derive Serialize/Deserialize. Map to an Output DTO in the use case.');
      }
      if (/_(repository|queries|gateway|publisher)\.rs$/.test(name)) {
        for (const m of src.matchAll(/\bpub\s+trait\s+(\w+)([^{]*)\{/g)) {
          if (!/\bSend\b/.test(m[2]) || !/\bSync\b/.test(m[2])) {
            report(file, 'port-send-sync', `Port \`${m[1]}\` must require \`Send + Sync\`: it is shared across tasks as \`Arc<dyn ${m[1]}>\`.`);
          }
        }
      }
      if (name.endsWith('_vo.rs')) {
        if (/\bimpl\s*(?:<[^>]*>\s*)?(?:[\w:]*::)?From\s*<\s*(?:&\s*(?:'\w+\s+)?)?(?:[\w:]*::)?(?:String|str)\s*>\s*for\b/.test(src)) {
          report(file, 'vo-no-infallible-from', 'A value object has no infallible `From<String>` / `From<&str>`: it would bypass `create`. Use `create` or `TryFrom`.');
        }
        if (publicField(src)) report(file, 'vo-private-fields', 'Value object fields must be private.');
        if (!has(src, 'create')) report(file, 'vo-create-factory', 'Value object must define `pub fn create(...)` that validates its input.');
        if (serde(src)) report(file, 'vo-not-serializable', 'Value objects never derive Serialize/Deserialize — Deserialize would bypass `create`.');
      }
    }
  }

  // ── Rule: handlers are one async fn and never map errors themselves ────────
  for (const feature of subdirs(join(infra, 'http')).filter((d) => d !== 'middleware')) {
    for (const name of rustFilesIn(join(infra, 'http', feature))) {
      if (!name.endsWith('_handler.rs')) continue;
      const file = join(infra, 'http', feature, name);
      const src = productionCode(file);
      const expected = name.slice(0, -3);
      const fns = [...src.matchAll(/\bpub\s+(?:async\s+)?fn\s+(\w+)/g)].map((m) => m[1]);
      if (fns.length !== 1 || fns[0] !== expected || !new RegExp(`\\bpub\\s+async\\s+fn\\s+${expected}\\b`).test(src)) {
        report(file, 'handler-shape', `A handler file exposes exactly one \`pub async fn ${expected}\`. Found: [${fns.join(', ') || 'none'}].`);
      }
      if (/\bErr\s*\(/.test(src) || /\.map_err\s*\(/.test(src) || ERROR_STATUSES.test(src)) {
        report(file, 'handler-no-error-mapping', 'Handlers never build or map errors. Return `Result<_, HttpError>`, use `?`, and let the central mapper pick the status.');
      }
    }
  }

  // ── Rule: consumers are one async fn and never map errors themselves ───────
  for (const feature of subdirs(join(infra, 'messaging'))) {
    for (const name of rustFilesIn(join(infra, 'messaging', feature))) {
      if (!name.endsWith('_consumer.rs')) continue;
      const file = join(infra, 'messaging', feature, name);
      const src = productionCode(file);
      const expected = name.slice(0, -3);
      const fns = [...src.matchAll(/\bpub\s+(?:async\s+)?fn\s+(\w+)/g)].map((m) => m[1]);
      if (fns.length !== 1 || fns[0] !== expected || !new RegExp(`\\bpub\\s+async\\s+fn\\s+${expected}\\b`).test(src)) {
        report(file, 'consumer-shape', `A consumer file exposes exactly one \`pub async fn ${expected}\`. Found: [${fns.join(', ') || 'none'}].`);
      }
      if (/\bErr\s*\(/.test(src) || /\.map_err\s*\(/.test(src)) {
        report(file, 'consumer-no-error-mapping', 'Consumers never build or map errors. Return `Result<(), ConsumeError>`, use `?`, and let `disposition.rs` decide ack, retry or dead-letter.');
      }
    }
  }

  return { layout: layout.kind, violations };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const explicit = process.argv.find((arg) => arg.startsWith('--cwd='));
  const root = explicit ? resolve(explicit.slice('--cwd='.length)) : process.cwd();
  const { layout, violations } = checkArchitecture(root);

  if (violations.length === 0) {
    console.log(`✓ check-architecture (rust, ${layout}): no violations`);
    process.exit(0);
  }
  console.error(`✗ check-architecture (rust): ${violations.length} violation(s)\n`);
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.file}`);
    console.error(`    → ${v.message}`);
  }
  process.exit(1);
}
