use std::sync::Arc;

use axum::Router;
use usecase::user::create_user::CreateUserUseCase;
use usecase::user::list_users::ListUsersUseCase;
use usecase::user::suspend_user::SuspendUserUseCase;

use super::user::user_routes::user_routes;

/// Everything the HTTP layer needs, built by the composition root.
/// One field per use case; no repository, pool or client ever appears here.
pub struct HttpDeps {
    pub create_user: Arc<CreateUserUseCase>,
    pub list_users: Arc<ListUsersUseCase>,
    pub suspend_user: Arc<SuspendUserUseCase>,
}

pub fn build_router(deps: &HttpDeps) -> Router {
    Router::new().merge(user_routes(deps))
}
