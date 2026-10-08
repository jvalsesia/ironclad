use axum::Router;
use axum::routing::{get, post};

use super::create_user_handler::create_user_handler;
use super::list_users_handler::list_users_handler;
use super::suspend_user_handler::suspend_user_handler;
use crate::http::router::HttpDeps;

/// Each handler receives exactly the use case it drives, nothing more.
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
