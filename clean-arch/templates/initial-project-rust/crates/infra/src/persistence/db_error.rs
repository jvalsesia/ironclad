use domain::shared::errors::AppError;

/// `sqlx` never crosses into `usecase` or `domain`: every database failure
/// leaves `infra` as an unexpected [`AppError`] that keeps the cause as `source()`.
pub(crate) fn db_error(err: sqlx::Error) -> AppError {
    AppError::unexpected(err)
}
