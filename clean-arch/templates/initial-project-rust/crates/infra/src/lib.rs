//! The outside world: HTTP, PostgreSQL, external APIs. Implements the ports
//! declared in `domain` and drives the use cases in `usecase`.

pub mod http;
pub mod persistence;
pub mod queries;
pub mod repository;
