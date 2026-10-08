//! Facade of the `user` feature: private modules, named re-exports, no logic.

mod email_vo;
mod errors;
mod user_entity;
mod user_queries;
mod user_repository;

pub use email_vo::Email;
pub use errors::UserError;
pub use user_entity::{User, UserId};
pub use user_queries::{UserQueries, UserSummary};
pub use user_repository::UserRepository;
