use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use domain::shared::pagination::PageInput;
use serde::Deserialize;
use usecase::user::list_users::{ListUsersInput, ListUsersOutput, ListUsersUseCase};

use crate::http::error::HttpError;
use crate::http::extract::ApiQuery;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListUsersQuery {
    #[serde(default = "default_page")]
    page: u32,
    #[serde(default = "default_page_size")]
    page_size: u32,
}

const fn default_page() -> u32 {
    1
}

const fn default_page_size() -> u32 {
    20
}

pub async fn list_users_handler(
    State(list_users): State<Arc<ListUsersUseCase>>,
    ApiQuery(query): ApiQuery<ListUsersQuery>,
) -> Result<Json<ListUsersOutput>, HttpError> {
    let output = list_users
        .execute(ListUsersInput {
            page: PageInput::new(query.page, query.page_size),
        })
        .await?;

    Ok(Json(output))
}
