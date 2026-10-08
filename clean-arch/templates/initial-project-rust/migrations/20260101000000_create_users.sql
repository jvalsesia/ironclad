CREATE TABLE users (
    id           UUID PRIMARY KEY,
    email        TEXT NOT NULL UNIQUE,
    is_suspended BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL
);
