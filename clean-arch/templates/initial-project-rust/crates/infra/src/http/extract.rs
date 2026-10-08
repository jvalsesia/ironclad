use axum::extract::{FromRequest, FromRequestParts};

use super::error::HttpError;

/// `axum::Json` whose rejection goes through [`HttpError`], so a malformed
/// body gets the same error envelope as every other failure.
#[derive(FromRequest)]
#[from_request(via(axum::Json), rejection(HttpError))]
pub struct ApiJson<T>(pub T);

/// `axum::extract::Query` with the same treatment.
#[derive(FromRequestParts)]
#[from_request(via(axum::extract::Query), rejection(HttpError))]
pub struct ApiQuery<T>(pub T);
