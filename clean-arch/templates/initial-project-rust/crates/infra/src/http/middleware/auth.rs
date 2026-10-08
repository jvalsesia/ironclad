use std::sync::Arc;

use async_trait::async_trait;
use axum::extract::{FromRequestParts, Request, State};
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::middleware::Next;
use axum::response::Response;
use domain::shared::errors::AppError;

use crate::http::error::HttpError;

/// The authenticated caller.
///
/// Authentication happens here, in middleware. Authorization ("may this actor
/// do that?") happens in the use case, which receives `actor_id` in its input.
#[derive(Debug, Clone)]
pub struct CurrentUser {
    pub id: String,
}

/// Resolves a bearer token to a user. Implemented by the project (session
/// table, JWT verifier, identity provider) and wired in the composition root.
#[async_trait]
pub trait SessionStore: Send + Sync {
    async fn get(&self, token: &str) -> Result<Option<CurrentUser>, AppError>;
}

/// Authentication layer. Install it with
/// `axum::middleware::from_fn_with_state(sessions, authenticate)`.
///
/// A request without a token passes through anonymously; a request with an
/// unknown token is rejected. Protected handlers then demand [`CurrentUser`].
pub async fn authenticate(
    State(sessions): State<Arc<dyn SessionStore>>,
    mut request: Request,
    next: Next,
) -> Result<Response, HttpError> {
    let token = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_owned);

    if let Some(token) = token {
        let user = sessions
            .get(&token)
            .await?
            .ok_or_else(AppError::unauthenticated)?;
        request.extensions_mut().insert(user);
    }

    Ok(next.run(request).await)
}

/// Taking `CurrentUser` as a handler argument makes the route protected:
/// an anonymous request is answered with 401 before the handler runs.
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
