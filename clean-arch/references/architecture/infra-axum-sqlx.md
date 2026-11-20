# Rust — infra with axum and sqlx, and the composition root

The `infra` and `app` crates: HTTP handlers, the central error mapper, authentication, PostgreSQL repositories, and wiring. Snippets come from `templates/initial-project-rust/`, which was compiled, linted and exercised against a real PostgreSQL.

---

## 1. Handlers

One file per handler: `infra/http/<feature>/<action>_<feature>_handler.rs`. It holds the wire-shape struct(s) and **one** `pub async fn` named after the file.

```rust
// crates/infra/src/http/user/create_user_handler.rs
/// Wire shape of the request. Shape only: whether the email is *valid* is the
/// value object's business, not the handler's.
#[derive(Debug, Deserialize)]
pub struct CreateUserBody {
    email: String,
}

pub async fn create_user_handler(
    State(create_user): State<Arc<CreateUserUseCase>>,
    ApiJson(body): ApiJson<CreateUserBody>,
) -> Result<(StatusCode, Json<CreateUserOutput>), HttpError> {
    let output = create_user
        .execute(CreateUserInput { email: body.email })
        .await?;

    Ok((StatusCode::CREATED, Json(output)))
}
```

A handler does four things and nothing else:

1. **Extracts** — body, query, path, `CurrentUser`.
2. **Builds the Input** by hand from what it extracted.
3. **Calls `execute`** with `?`.
4. **Returns** the Output with the success status.

Rules:

- The body struct (`#[derive(Deserialize)]`) validates shape. Use `#[serde(rename_all = "camelCase")]` when a field has more than one word.
- The state is exactly the use case it drives: `State<Arc<CreateUserUseCase>>`. Never a pool, a repository, or a bag of everything.
- The return type is `Result<_, HttpError>`.
- **No error handling.** No `match` on the result, no `map_err`, no `Err(..)`, no `StatusCode::NOT_FOUND` and friends. This is the `try/catch` ban of rule 16; the architecture check flags all of them (`handler-no-error-mapping`).

Query parameters and protected routes look like this:

```rust
// list_users_handler.rs
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListUsersQuery {
    #[serde(default = "default_page")]
    page: u32,
    #[serde(default = "default_page_size")]
    page_size: u32,
}

pub async fn list_users_handler(
    State(list_users): State<Arc<ListUsersUseCase>>,
    ApiQuery(query): ApiQuery<ListUsersQuery>,
) -> Result<Json<ListUsersOutput>, HttpError> { /* … */ }

// suspend_user_handler.rs — taking `CurrentUser` makes the route protected
pub async fn suspend_user_handler(
    State(suspend_user): State<Arc<SuspendUserUseCase>>,
    current_user: CurrentUser,
    Path(user_id): Path<String>,
) -> Result<Json<SuspendUserOutput>, HttpError> {
    let output = suspend_user
        .execute(SuspendUserInput { actor_id: current_user.id, user_id })
        .await?;

    Ok(Json(output))
}
```

IDs arrive as `String` and are parsed by the use case (`UserId::parse`), so a malformed ID gets the same `INVALID_ID` answer on every route.

---

## 2. The central error mapper

`infra/http/error.rs` is the only file that knows about status codes.

```rust
#[derive(Debug)]
pub enum HttpError {
    /// The request did not have the expected shape. Raised by the extractors.
    BadRequest(String),
    App(AppError),
}

impl From<AppError> for HttpError { /* Self::App */ }
impl From<JsonRejection> for HttpError { /* Self::BadRequest(rejection.body_text()) */ }
impl From<QueryRejection> for HttpError { /* Self::BadRequest(rejection.body_text()) */ }

const fn status_of(kind: ErrorKind) -> StatusCode {
    match kind {
        ErrorKind::Invalid => StatusCode::UNPROCESSABLE_ENTITY,
        ErrorKind::NotFound => StatusCode::NOT_FOUND,
        ErrorKind::Conflict => StatusCode::CONFLICT,
        ErrorKind::Unauthenticated => StatusCode::UNAUTHORIZED,
        ErrorKind::Forbidden => StatusCode::FORBIDDEN,
        ErrorKind::Unexpected => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

impl IntoResponse for HttpError { /* builds { "code", "message" } */ }
```

| Source                                   | Status | `code`               |
|------------------------------------------|--------|----------------------|
| Malformed JSON, missing field, wrong type | 400    | `VALIDATION_ERROR`   |
| `ErrorKind::Unauthenticated`             | 401    | `UNAUTHENTICATED`    |
| `ErrorKind::Forbidden`                   | 403    | `FORBIDDEN`          |
| `ErrorKind::NotFound`                    | 404    | the feature's code   |
| `ErrorKind::Conflict`                    | 409    | the feature's code   |
| `ErrorKind::Invalid`                     | 422    | the feature's code   |
| `ErrorKind::Unexpected`                  | 500    | `INTERNAL_ERROR`     |

An unexpected error is logged with its cause (`tracing::error!`) and answered with the generic message — the cause never reaches the caller.

### Extractors

Plain `axum::Json` answers a bad body with its own plain-text response. `infra/http/extract.rs` wraps it so the rejection goes through `HttpError` and gets the same envelope:

```rust
#[derive(FromRequest)]
#[from_request(via(axum::Json), rejection(HttpError))]
pub struct ApiJson<T>(pub T);

#[derive(FromRequestParts)]
#[from_request(via(axum::extract::Query), rejection(HttpError))]
pub struct ApiQuery<T>(pub T);
```

Handlers use `ApiJson` and `ApiQuery`, never the raw extractors, for input. (`axum::Json` is still what they *return*.) This needs axum's `macros` feature.

---

## 3. Routes and the router

Each feature exports one function that binds every handler to **its own** use case:

```rust
// crates/infra/src/http/user/user_routes.rs
pub fn user_routes(deps: &HttpDeps) -> Router {
    Router::new()
        .route(
            "/users",
            post(create_user_handler).with_state(deps.create_user.clone()),
        )
        .route(
            "/users",
            get(list_users_handler).with_state(deps.list_users.clone()),
        )
        .route(
            "/users/{id}/suspend",
            post(suspend_user_handler).with_state(deps.suspend_user.clone()),
        )
}
```

`infra/http/router.rs` declares what the HTTP layer needs and merges the features:

```rust
/// One field per use case; no repository, pool or client ever appears here.
pub struct HttpDeps {
    pub create_user: Arc<CreateUserUseCase>,
    pub list_users: Arc<ListUsersUseCase>,
    pub suspend_user: Arc<SuspendUserUseCase>,
}

pub fn build_router(deps: &HttpDeps) -> Router {
    Router::new().merge(user_routes(deps))
}
```

Adding an endpoint is therefore: a use case file, a handler file, one field in `HttpDeps`, one `.route(..)` line, one line in `main.rs`.

---

## 4. Authentication

`infra/http/middleware/auth.rs` holds three things:

- `CurrentUser { id }` — the authenticated caller.
- `trait SessionStore` — resolves a bearer token to a `CurrentUser`. The project implements it (session table, JWT verifier, identity provider).
- `authenticate` — the layer. A request without a token passes through anonymously; a request with an unknown token is rejected with 401.

```rust
impl<S: Send + Sync> FromRequestParts<S> for CurrentUser {
    type Rejection = HttpError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<Self>()
            .cloned()
            .ok_or_else(|| AppError::unauthenticated().into())
    }
}
```

A route is protected by **taking `CurrentUser` as a handler argument**: an anonymous request is answered with 401 before the handler runs. There is no list of protected paths to keep in sync.

Install the layer in the composition root:

```rust
let router = build_router(&deps)
    .layer(axum::middleware::from_fn_with_state(sessions, authenticate));
```

Authentication stops here. Whether *this* actor may do *that* is decided in the use case (rule 18).

---

## 5. Repositories with sqlx

### The row is the mapper

```rust
// crates/infra/src/repository/user/user_row.rs
#[derive(Debug, sqlx::FromRow)]
pub(crate) struct UserRow {
    id: Uuid,
    email: String,
    is_suspended: bool,
    created_at: DateTime<Utc>,
}

impl From<UserRow> for User {
    fn from(row: UserRow) -> Self {
        Self::restore(
            UserId::from_uuid(row.id),
            Email::from_trusted(row.email),
            row.is_suspended,
            row.created_at,
        )
    }
}
```

`#[derive(sqlx::FromRow)]` goes on the row, never on the entity. Rehydration uses `restore` and `from_trusted` — never `create`.

### The implementation

```rust
// crates/infra/src/repository/user/pg_user_repository.rs
pub struct PgUserRepository {
    pool: PgPool,
}

#[async_trait]
impl UserRepository for PgUserRepository {
    async fn find_by_id(&self, id: UserId) -> Result<Option<User>, AppError> {
        let row = sqlx::query_as::<_, UserRow>(
            "SELECT id, email, is_suspended, created_at FROM users WHERE id = $1",
        )
        .bind(id.as_uuid())
        .fetch_optional(&self.pool)
        .await
        .map_err(db_error)?;

        Ok(row.map(User::from))
    }

    async fn save(&self, user: &User) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO users (id, email, is_suspended, created_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (id) DO UPDATE
             SET email = EXCLUDED.email, is_suspended = EXCLUDED.is_suspended",
        )
        .bind(user.id().as_uuid())
        .bind(user.email().as_str())
        .bind(user.is_suspended())
        .bind(user.created_at())
        .execute(&self.pool)
        .await
        .map_err(db_error)?;

        Ok(())
    }
    /* find_by_email, delete … */
}
```

- `save` is an upsert, so the use case never asks "insert or update?".
- `fetch_optional` → `Ok(None)` for a missing row. Never `fetch_one` on a lookup: it would turn "not found" into a 500.
- Every `sqlx::Error` leaves `infra` through `db_error` (`infra/persistence/db_error.rs`), which wraps it in `AppError::unexpected`. `sqlx` types never appear in a port signature.
- Queries are always parameterized (`$1`, `.bind(..)`). Never build SQL with `format!`.
- List the columns; no `SELECT *`.

### Compile-time checked queries

The starter uses the function form (`sqlx::query_as::<_, UserRow>(..)`) so that it builds without a database. Projects that want sqlx's compile-time checking switch to the macros (`sqlx::query_as!(UserRow, "…", id.as_uuid())`), enable the `macros` feature, and commit the offline cache produced by `cargo sqlx prepare --workspace`. The structure does not change: same file, same row struct, same `map_err(db_error)`.

### Queries (read side)

`infra/queries/<feature>/pg_<feature>_queries.rs` selects straight into a private row struct and maps it to the read model. It does not go through the entity or the repository. A paginated `list` runs the page query (`LIMIT $1 OFFSET $2`, with a deterministic `ORDER BY`) and a `COUNT(*)`.

### In-memory fakes

Every repository and every queries implementation has an in-memory sibling in the same folder (`in_memory_user_repository.rs`, `in_memory_user_queries.rs`). They are part of the architecture, not test scaffolding: use case tests run on them, and the architecture check fails when one is missing.

```rust
#[derive(Default)]
pub struct InMemoryUserRepository {
    users: Mutex<HashMap<UserId, User>>,
}
```

The fake must behave like the real thing where the contract says so: `save` upserts, a missing ID is `Ok(None)`, `delete` of a missing ID is `Ok(())`. In-memory queries read the same store the in-memory repository writes to.

---

## 6. Composition root

`crates/app/src/main.rs` is the only place that names concrete `infra` types. Wiring is strictly top-down:

```rust
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    // 1. Configuration
    let config = Config::from_env()?;

    // 2. Infrastructure clients
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&config.database_url)
        .await
        .context("cannot connect to the database")?;

    // 3. Repositories, queries, gateways — as trait objects from here on
    let user_repo: Arc<dyn UserRepository> = Arc::new(PgUserRepository::new(pool.clone()));
    let user_queries: Arc<dyn UserQueries> = Arc::new(PgUserQueries::new(pool));

    // 4. Use cases
    let deps = HttpDeps {
        create_user: Arc::new(CreateUserUseCase::new(user_repo.clone())),
        list_users: Arc::new(ListUsersUseCase::new(user_queries)),
        suspend_user: Arc::new(SuspendUserUseCase::new(user_repo)),
    };

    // 5. HTTP
    let router = build_router(&deps);
    let listener = TcpListener::bind(("0.0.0.0", config.port)).await?;
    axum::serve(listener, router).await?;

    Ok(())
}
```

- `anyhow` is used here and only here. Libraries (`domain`, `usecase`, `infra`) return typed errors. Detection: `[anyhow-only-in-app]` (manifest and source).
- `main.rs` contains wiring and nothing else — no handler, no SQL, no business rule.
- Nothing is constructed lazily or stored in a global. If a use case needs something, it gets it in step 4.

### Configuration

```rust
// crates/app/src/config.rs
//! The only module in the workspace that reads the environment.
#![expect(
    clippy::disallowed_methods,
    reason = "configuration is read here and nowhere else"
)]

pub struct Config {
    pub database_url: String,
    pub port: u16,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> { /* env::var(..) with context */ }
}
```

`clippy.toml` disallows `std::env::var`, `var_os` and `vars` across the workspace; `config.rs` is the single module that opts out. Everything else receives values through constructors: an API key reaches a gateway as `OpenAiTranscriptionGateway::new(http, config.openai_api_key.clone())`.

---

## 7. Common pitfalls

- **A handler that takes `State<PgPool>`.** Handlers talk to use cases.
- **`match use_case.execute(..).await { Err(e) => … }` in a handler.** Use `?`.
- **`impl IntoResponse for AppError` in `domain`.** The domain does not know HTTP exists. The mapping is `HttpError`, in `infra`.
- **`#[derive(FromRow)]` or `#[derive(Serialize)]` on an entity** to save a struct. Write the row and the Output.
- **`fetch_one` for a lookup.** Use `fetch_optional`.
- **A repository method per screen** (`find_active_users_with_orders`). That is a query.
- **Reading `std::env::var` in a gateway.** Pass the value in from `config.rs`.
- **A `static` pool.** Construct it in `main` and pass it down.

---

## Cross-references

- `use-cases-and-ports.md` — the traits implemented here.
- `domain-modeling.md` — `AppError`, `restore`, `from_trusted`.
