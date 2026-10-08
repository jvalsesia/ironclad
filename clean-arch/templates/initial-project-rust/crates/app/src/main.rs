//! Composition root: the only place that names concrete `infra` types.
//!
//! Wiring order is strictly top-down:
//! config → infrastructure clients → repositories/queries/gateways →
//! use cases → HTTP.

mod config;

use std::path::Path;
use std::sync::Arc;

use anyhow::Context;
use domain::user::{UserQueries, UserRepository};
use infra::http::router::{HttpDeps, build_router};
use infra::queries::user::pg_user_queries::PgUserQueries;
use infra::repository::user::pg_user_repository::PgUserRepository;
use sqlx::migrate::Migrator;
use sqlx::postgres::PgPoolOptions;
use tokio::net::TcpListener;
use usecase::user::create_user::CreateUserUseCase;
use usecase::user::list_users::ListUsersUseCase;
use usecase::user::suspend_user::SuspendUserUseCase;

use crate::config::Config;

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
    Migrator::new(Path::new("./migrations"))
        .await?
        .run(&pool)
        .await
        .context("cannot run migrations")?;

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
    //
    // `POST /users/{id}/suspend` is a protected route. To make it reachable,
    // implement `infra::http::middleware::auth::SessionStore` and add
    // `.layer(axum::middleware::from_fn_with_state(sessions, authenticate))`.
    let router = build_router(&deps);

    let listener = TcpListener::bind(("0.0.0.0", config.port)).await?;
    tracing::info!(port = config.port, "listening");
    axum::serve(listener, router).await?;

    Ok(())
}
