//! The only module in the workspace that reads the environment.
#![expect(
    clippy::disallowed_methods,
    reason = "configuration is read here and nowhere else"
)]

use std::env;

use anyhow::Context;

const DEFAULT_PORT: u16 = 3000;

pub struct Config {
    pub database_url: String,
    pub port: u16,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url = env::var("DATABASE_URL").context("DATABASE_URL is required")?;
        let port = match env::var("PORT") {
            Ok(raw) => raw.parse().context("PORT must be a port number")?,
            Err(_) => DEFAULT_PORT,
        };

        Ok(Self { database_url, port })
    }
}
