use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use usecase::user::create_user::{CreateUserInput, CreateUserOutput, CreateUserUseCase};

use crate::http::error::HttpError;
use crate::http::extract::ApiJson;

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
