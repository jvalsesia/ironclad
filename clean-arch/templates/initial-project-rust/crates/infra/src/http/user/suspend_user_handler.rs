use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use usecase::user::suspend_user::{SuspendUserInput, SuspendUserOutput, SuspendUserUseCase};

use crate::http::error::HttpError;
use crate::http::middleware::auth::CurrentUser;

pub async fn suspend_user_handler(
    State(suspend_user): State<Arc<SuspendUserUseCase>>,
    current_user: CurrentUser,
    Path(user_id): Path<String>,
) -> Result<Json<SuspendUserOutput>, HttpError> {
    let output = suspend_user
        .execute(SuspendUserInput {
            actor_id: current_user.id,
            user_id,
        })
        .await?;

    Ok(Json(output))
}
