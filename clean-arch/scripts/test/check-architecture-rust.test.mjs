import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkArchitecture } from '../check-architecture-rust.mjs';

const TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), '../../templates/initial-project-rust');

/** Copies the starter without build output (`target/`, created by the gates). */
const copyTemplate = (root) =>
  cpSync(TEMPLATE, root, { recursive: true, filter: (src) => src !== join(TEMPLATE, 'target') });

/** Copies the starter, applies `mutate(root)`, returns the rule ids reported. */
function rulesAfter(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'clean-arch-rust-'));
  try {
    copyTemplate(root);
    mutate(root);
    return checkArchitecture(root).violations.map((v) => v.rule);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const edit = (root, file, fn) => {
  const path = join(root, file);
  writeFileSync(path, fn(readFileSync(path, 'utf8')));
};
const append = (root, file, text) => edit(root, file, (src) => `${src}\n${text}\n`);
/** Inserts `text` before the test module, i.e. into production code. */
const addCode = (root, file, text) =>
  edit(root, file, (src) =>
    src.includes('#[cfg(test)]') ? src.replace('#[cfg(test)]', `${text}\n\n#[cfg(test)]`) : `${src}\n${text}\n`,
  );

const DOMAIN = 'crates/domain/src';
const USECASE = 'crates/usecase/src';
const INFRA = 'crates/infra/src';

/** Turns the workspace starter into the single-crate layout. */
function toSingleCrate(root) {
  mkdirSync(join(root, 'src'));
  for (const layer of ['domain', 'usecase', 'infra']) {
    renameSync(join(root, 'crates', layer, 'src'), join(root, 'src', layer));
    renameSync(join(root, 'src', layer, 'lib.rs'), join(root, 'src', layer, 'mod.rs'));
  }
  renameSync(join(root, 'crates/app/src/main.rs'), join(root, 'src/main.rs'));
  renameSync(join(root, 'crates/app/src/config.rs'), join(root, 'src/config.rs'));
  rmSync(join(root, 'crates'), { recursive: true });
}

test('the starter has no violations', () => {
  const { layout, violations } = checkArchitecture(TEMPLATE);
  assert.equal(layout, 'workspace');
  assert.deepEqual(violations, []);
});

test('the single-crate layout is recognized and clean', () => {
  const root = mkdtempSync(join(tmpdir(), 'clean-arch-rust-'));
  try {
    copyTemplate(root);
    toSingleCrate(root);
    const { layout, violations } = checkArchitecture(root);
    assert.equal(layout, 'single-crate');
    assert.deepEqual(violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown layout is reported', () => {
  assert.deepEqual(rulesAfter((root) => rmSync(join(root, 'crates'), { recursive: true })), ['layout']);
});

const cases = [
  ['domain depending on infra', 'crate-deps',
    (r) => append(r, 'crates/domain/Cargo.toml', 'infra.workspace = true')],
  ['usecase depending on infra outside dev-dependencies', 'crate-deps',
    (r) => edit(r, 'crates/usecase/Cargo.toml', (s) => s.replace('domain.workspace = true', 'domain.workspace = true\ninfra.workspace = true'))],
  ['an I/O crate in the domain manifest', 'forbidden-crate',
    (r) => edit(r, 'crates/domain/Cargo.toml', (s) => s.replace('uuid.workspace = true', 'uuid.workspace = true\nsqlx.workspace = true'))],
  ['an I/O crate used in domain source', 'forbidden-crate',
    (r) => addCode(r, `${DOMAIN}/user/user_entity.rs`, 'pub type Pool = sqlx::PgPool;')],
  ['std::fs in a use case', 'forbidden-crate',
    (r) => addCode(r, `${USECASE}/user/create_user.rs`, 'const _: fn(&str) = |p| drop(std::fs::read(p));')],
  ['reading the environment outside config', 'env-outside-config',
    (r) => addCode(r, `${INFRA}/persistence/db_error.rs`, 'pub(crate) fn url() -> Option<String> { std::env::var("DATABASE_URL").ok() }')],
  ['a file that is not snake_case', 'snake-case',
    (r) => renameSync(join(r, `${INFRA}/http/error.rs`), join(r, `${INFRA}/http/httpError.rs`))],
  ['logic in mod.rs', 'mod-facade',
    (r) => append(r, `${DOMAIN}/user/mod.rs`, 'pub fn helper() {}')],
  ['a glob re-export', 'mod-facade',
    (r) => append(r, `${DOMAIN}/user/mod.rs`, 'pub use errors::*;')],
  ['an extra file in domain/shared', 'shared-whitelist',
    (r) => writeFileSync(join(r, `${DOMAIN}/shared/utils.rs`), '')],
  ['a domain file without a role suffix', 'naming-suffix',
    (r) => writeFileSync(join(r, `${DOMAIN}/user/helpers.rs`), '')],
  ['a file directly in usecase/', 'naming-suffix',
    (r) => writeFileSync(join(r, `${USECASE}/create_user.rs`), '')],
  ['a service file among handlers', 'naming-suffix',
    (r) => writeFileSync(join(r, `${INFRA}/http/user/user_service.rs`), '')],
  ['usecase/shared', 'usecase-forbidden-folder',
    (r) => mkdirSync(join(r, `${USECASE}/shared`))],
  ['a repository without its in-memory fake', 'missing-in-memory-repo',
    (r) => rmSync(join(r, `${INFRA}/repository/user/in_memory_user_repository.rs`))],
  ['queries without their in-memory fake', 'missing-in-memory-queries',
    (r) => rmSync(join(r, `${INFRA}/queries/user/in_memory_user_queries.rs`))],
  ['a use case with a second public method', 'usecase-single-execute',
    (r) => addCode(r, `${USECASE}/user/create_user.rs`, 'impl CreateUserUseCase { pub fn preview(&self) {} }')],
  ['two use cases in one file', 'usecase-shape',
    (r) => addCode(r, `${USECASE}/user/create_user.rs`, 'pub struct DeleteUserUseCase;')],
  ['a list use case without PageInput', 'list-page-input',
    (r) => edit(r, `${USECASE}/user/list_users.rs`, (s) => s.replaceAll('PageInput', 'Paging'))],
  ['a public entity field', 'entity-private-fields',
    (r) => edit(r, `${DOMAIN}/user/user_entity.rs`, (s) => s.replace('    is_suspended: bool,\n    created_at', '    pub is_suspended: bool,\n    created_at'))],
  ['an entity without restore', 'entity-restore-factory',
    (r) => edit(r, `${DOMAIN}/user/user_entity.rs`, (s) => s.replace('pub fn restore(', 'pub fn rebuild('))],
  ['a serializable entity', 'entity-not-serializable',
    (r) => edit(r, `${DOMAIN}/user/user_entity.rs`, (s) => s.replace('#[derive(Debug, Clone)]', '#[derive(Debug, Clone, serde::Serialize)]'))],
  ['a setter in the domain', 'no-setters-in-domain',
    (r) => addCode(r, `${DOMAIN}/user/user_entity.rs`, 'impl User { pub fn set_email(&mut self, email: Email) { self.email = email; } }')],
  ['a value object without create', 'vo-create-factory',
    (r) => edit(r, `${DOMAIN}/user/email_vo.rs`, (s) => s.replace('pub fn create(', 'pub fn new('))],
  ['a value object with a public field', 'vo-private-fields',
    (r) => edit(r, `${DOMAIN}/user/email_vo.rs`, (s) => s.replace('pub struct Email(String);', 'pub struct Email(pub String);'))],
  ['a deserializable value object', 'vo-not-serializable',
    (r) => edit(r, `${DOMAIN}/user/email_vo.rs`, (s) => s.replace('#[derive(Debug, Clone, PartialEq, Eq)]', '#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]'))],
  ['a handler that maps an error itself', 'handler-no-error-mapping',
    (r) => edit(r, `${INFRA}/http/user/create_user_handler.rs`, (s) => s.replace('.await?;', '.await.map_err(HttpError::from)?;'))],
  ['a handler that picks an error status', 'handler-no-error-mapping',
    (r) => addCode(r, `${INFRA}/http/user/create_user_handler.rs`, 'const _: StatusCode = StatusCode::NOT_FOUND;')],
  ['two handlers in one file', 'handler-shape',
    (r) => addCode(r, `${INFRA}/http/user/create_user_handler.rs`, 'pub async fn other_handler() {}')],
  ['an #[allow] that silences a lint', 'no-silenced-lint',
    (r) => addCode(r, `${INFRA}/http/user/create_user_handler.rs`, '#[allow(clippy::unwrap_used)]\nfn helper() {}')],
  ['an inner #![allow]', 'no-silenced-lint',
    (r) => edit(r, `${DOMAIN}/lib.rs`, (s) => `#![allow(dead_code)]\n${s}`)],
  ['a #[rustfmt::skip]', 'no-silenced-lint',
    (r) => addCode(r, `${USECASE}/user/create_user.rs`, '#[rustfmt::skip]\nconst X: u8 = 1;')],
  ['a static mut', 'no-global-state',
    (r) => addCode(r, `${INFRA}/persistence/db_error.rs`, 'static mut COUNTER: u64 = 0;')],
  ['lazy_static!', 'no-global-state',
    (r) => addCode(r, `${INFRA}/persistence/db_error.rs`, 'lazy_static! { static ref X: u8 = 1; }')],
  ['a static OnceLock holding a pool', 'no-global-state',
    (r) => addCode(r, `${INFRA}/persistence/db_error.rs`, 'static POOL: std::sync::OnceLock<sqlx::PgPool> = std::sync::OnceLock::new();')],
  ['a static lock', 'no-global-state',
    (r) => addCode(r, `${INFRA}/persistence/db_error.rs`, 'static CACHE: std::sync::Mutex<Vec<u8>> = std::sync::Mutex::new(Vec::new());')],
  ['a RefCell in an entity', 'no-interior-mutability',
    (r) => addCode(r, `${DOMAIN}/user/user_entity.rs`, 'pub struct Holder { inner: std::cell::RefCell<u8> }')],
  ['an Arc<Mutex> in a use case', 'no-interior-mutability',
    (r) => addCode(r, `${USECASE}/user/create_user.rs`, 'pub(crate) type Shared = std::sync::Arc<Mutex<Vec<u8>>>;')],
  ['a use case generic over its repository', 'usecase-generic-ports',
    (r) => edit(r, `${USECASE}/user/create_user.rs`, (s) => s.replace(/pub struct CreateUserUseCase\b/, 'pub struct CreateUserUseCase<R>'))],
  ['execute taking &mut self', 'usecase-stateless',
    (r) => edit(r, `${USECASE}/user/create_user.rs`, (s) => s.replace(/fn execute\(\s*&self/, 'fn execute(&mut self'))],
  ['a use case holding another use case', 'usecase-no-composition',
    (r) => addCode(r, `${USECASE}/user/create_user.rs`, 'pub(crate) type Other = std::sync::Arc<crate::user::SuspendUserUseCase>;')],
  ['Deref in the domain', 'no-deref-in-domain',
    (r) => addCode(r, `${DOMAIN}/user/email_vo.rs`, 'impl std::ops::Deref for Email { type Target = String; fn deref(&self) -> &String { &self.0 } }')],
  ['Default on an entity', 'no-default-entity-vo',
    (r) => edit(r, `${DOMAIN}/user/user_entity.rs`, (s) => s.replace('#[derive(Debug, Clone)]', '#[derive(Debug, Clone, Default)]'))],
  ['an infallible From<String> on a value object', 'vo-no-infallible-from',
    (r) => addCode(r, `${DOMAIN}/user/email_vo.rs`, 'impl From<String> for Email { fn from(s: String) -> Self { Self(s) } }')],
  ['an infallible From<&str> on a value object', 'vo-no-infallible-from',
    (r) => addCode(r, `${DOMAIN}/user/email_vo.rs`, "impl<'a> From<&'a str> for Email { fn from(s: &'a str) -> Self { Self(s.to_owned()) } }")],
  ['a port without Send + Sync', 'port-send-sync',
    (r) => edit(r, `${DOMAIN}/user/user_repository.rs`, (s) => s.replace('pub trait UserRepository: Send + Sync {', 'pub trait UserRepository {'))],
  ['a port with Send but not Sync', 'port-send-sync',
    (r) => edit(r, `${DOMAIN}/user/user_queries.rs`, (s) => s.replace('pub trait UserQueries: Send + Sync {', 'pub trait UserQueries: Send {'))],
  ['anyhow in the infra manifest', 'anyhow-only-in-app',
    (r) => edit(r, 'crates/infra/Cargo.toml', (s) => s.replace('uuid.workspace = true', 'uuid.workspace = true\nanyhow.workspace = true'))],
  ['anyhow in domain source', 'anyhow-only-in-app',
    (r) => addCode(r, `${DOMAIN}/user/user_entity.rs`, 'pub type Fallible = anyhow::Result<()>;')],
  ['Default on a value object', 'no-default-entity-vo',
    (r) => addCode(r, `${DOMAIN}/user/email_vo.rs`, 'impl Default for Email { fn default() -> Self { Self(String::new()) } }')],
];

for (const [name, rule, mutate] of cases) {
  test(`flags ${name}`, () => {
    const rules = rulesAfter(mutate);
    assert.ok(rules.includes(rule), `expected "${rule}", got [${rules.join(', ')}]`);
  });
}

test('flags an outward import in the single-crate layout', () => {
  const rules = rulesAfter((root) => {
    toSingleCrate(root);
    addCode(root, 'src/domain/user/user_entity.rs', 'pub type Repo = crate::infra::repository::user::pg_user_repository::PgUserRepository;');
  });
  assert.ok(rules.includes('layer-import'), `got [${rules.join(', ')}]`);
});

test('a static LazyLock<Regex> is not global state', () => {
  const rules = rulesAfter((root) =>
    addCode(root, `${INFRA}/persistence/db_error.rs`, 'static SLUG: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| todo_regex());'));
  assert.ok(!rules.includes('no-global-state'), `got [${rules.join(', ')}]`);
});

test('#![expect(..)] is not a silenced lint', () => {
  // The starter's config.rs uses `#![expect(clippy::disallowed_methods)]`.
  const { violations } = checkArchitecture(TEMPLATE);
  assert.equal(violations.filter((v) => v.rule === 'no-silenced-lint').length, 0);
});

test('TryFrom<String> on a value object is allowed', () => {
  const rules = rulesAfter((root) =>
    addCode(root, `${DOMAIN}/user/email_vo.rs`, 'impl TryFrom<String> for Email { type Error = UserError; fn try_from(s: String) -> Result<Self, UserError> { Self::create(&s) } }'));
  assert.ok(!rules.includes('vo-no-infallible-from'), `got [${rules.join(', ')}]`);
});

test('a port with Send + Sync in a where clause is accepted', () => {
  const rules = rulesAfter((root) =>
    edit(root, `${DOMAIN}/user/user_repository.rs`, (s) => s.replace('pub trait UserRepository: Send + Sync {', 'pub trait UserRepository\nwhere\n    Self: Send + Sync,\n{')));
  assert.ok(!rules.includes('port-send-sync'), `got [${rules.join(', ')}]`);
});

test('a Mutex inside an infra adapter is allowed', () => {
  const rules = rulesAfter((root) =>
    addCode(root, `${INFRA}/persistence/db_error.rs`, 'pub(crate) struct Cache { inner: std::sync::Mutex<Vec<u8>> }'));
  assert.ok(!rules.includes('no-interior-mutability'), `got [${rules.join(', ')}]`);
});

test('test modules are exempt from the I/O ban', () => {
  // The starter's use case tests use `#[tokio::test]` and import from `infra`.
  const { violations } = checkArchitecture(TEMPLATE);
  assert.equal(violations.filter((v) => v.rule === 'forbidden-crate').length, 0);
});
