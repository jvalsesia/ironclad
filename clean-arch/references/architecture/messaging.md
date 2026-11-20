# Rust — messaging with Kafka, RabbitMQ, NATS and SQS

Where domain events, message brokers, producers and consumers go in this layout. The broker is infrastructure, the same as PostgreSQL: the domain records what happened, `infra` turns it into a message and moves it, `app` wires the clients.

**Opt-in.** The Rust starter ships no broker. Before adding one, stop and agree with the user on: which broker, the outbox (§ 4) or a direct publish (§ 5), the wire format (§ 6), topic naming, and the retry and dead-letter policy (§ 8). Pick **one** broker per project unless there is a stated reason for two.

Code below is a sketch of the shape. Client APIs shift between crate versions (`rdkafka`, `lapin`, `async-nats`, `aws-sdk-sqs`); check the version you pin.

---

## 1. Where each piece lives

| Layer | Piece | File |
|---|---|---|
| `domain` | Event envelope (id, time) | `domain/shared/event.rs` (on the whitelist): `Recorded<E>` |
| `domain` | The feature's events, plain data | `domain/<feature>/events.rs`: `enum FeatureEvent` |
| `domain` | Recording events | the entity: a private `Vec<Recorded<FeatureEvent>>`, read by `pending_events()` |
| `domain` | Publisher port (direct publish only, § 5) | `domain/<feature>/<feature>_event_publisher.rs`: `trait FeatureEventPublisher` |
| `usecase` | Nothing new for the outbox; a publisher port for a direct publish | — |
| `infra` | Wire envelope, broker-agnostic `Producer` trait, one file per broker | `infra/messaging/`: `envelope.rs`, `producer.rs`, `kafka_producer.rs`, `rabbitmq_producer.rs`, `nats_producer.rs`, `sqs_producer.rs`, `in_memory_producer.rs` |
| `infra` | Outbox writer and relay | `infra/messaging/outbox.rs`, `infra/messaging/outbox_relay.rs` |
| `infra` | Event → message mapping (the "row" of messaging) | `infra/messaging/<feature>/<feature>_message.rs` |
| `infra` | Publisher port implementation + fake | `infra/messaging/<feature>/broker_<feature>_event_publisher.rs`, `in_memory_<feature>_event_publisher.rs` |
| `infra` | Inbound consumer, one per file | `infra/messaging/<feature>/<action>_<feature>_consumer.rs` |
| `infra` | The central result → ack mapper | `infra/messaging/disposition.rs` |
| `infra` | Receive loop per broker | `infra/messaging/kafka_subscriber.rs`, `rabbitmq_subscriber.rs`, … |
| `app` | Broker URLs, client construction, spawning the relay and subscribers, shutdown | `config.rs`, `main.rs` |

Broker client crates (`rdkafka`, `lapin`, `async-nats`, `aws-sdk-sqs`, `aws-sdk-sns`, `aws-config`) are I/O crates: allowed in `infra` and `app`, forbidden in `domain` and `usecase` (`[forbidden-crate]`).

Data still flows one way (`../rust-patterns/architectural-principles.md` § 1). Outbound: entity → repository `save` → outbox → relay → broker. Inbound: broker → subscriber → consumer → use case. A consumer acknowledgment is the subscriber's job, never a callback into the use case.

---

## 2. Choosing a broker

The choice is the user's. What each one gives you, and what it does not:

| | Kafka (`rdkafka`) | RabbitMQ (`lapin`) | NATS JetStream (`async-nats`) | SQS (`aws-sdk-sqs`) |
|---|---|---|---|---|
| Model | Partitioned, replayable log | Exchanges route to queues | Subjects stored in streams | Managed queue |
| Fan-out | Consumer groups read the same topic | One queue per consumer service, bound to an exchange | One durable consumer per service | One queue per service, fed by an SNS topic |
| Ordering | Per partition (choose the key) | Per queue, with one consumer | Per stream / subject | None; FIFO queues order per `MessageGroupId` |
| Replay | Yes, by offset | No | Yes, by sequence | No |
| Per-message nack | No (commit offsets) | Yes | Yes | Yes (visibility timeout) |
| Dedup on publish | Idempotent producer (per session) | No | `Nats-Msg-Id` within a window | FIFO only, 5-minute window |
| Watch out for | `librdkafka` is a C library: the build needs it (`cmake-build` feature or a system package) | Unbounded requeue loops; set a prefetch | Core NATS (no JetStream) is at-most-once: not for events that matter | 256 KB message limit; at-least-once even on FIFO |

**Every option is at-least-once** for this design. Kafka's transactional "exactly-once" does not extend to PostgreSQL. Consumers must be idempotent (§ 9).

---

## 3. Domain events

### The envelope: `shared/event.rs`

Identity and time are domain facts (rule 8), so they are set when the event is recorded, not by the broker or the database:

```rust
// crates/domain/src/shared/event.rs
use chrono::{DateTime, Utc};

use super::id::Id;

/// A domain event as it was recorded: the event, its id and when it happened.
#[derive(Debug, Clone)]
pub struct Recorded<E> {
    id: Id<E>,
    occurred_at: DateTime<Utc>,
    event: E,
}

impl<E> Recorded<E> {
    pub fn new(event: E) -> Self {
        Self { id: Id::generate(), occurred_at: Utc::now(), event }
    }

    pub const fn id(&self) -> Id<E> { self.id }
    pub const fn occurred_at(&self) -> DateTime<Utc> { self.occurred_at }
    pub const fn event(&self) -> &E { &self.event }
}
```

### The feature's events: `<feature>/events.rs`

```rust
// crates/domain/src/user/events.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UserEvent {
    Registered { user_id: UserId, email: Email },
    Suspended { user_id: UserId },
}
```

- **Past tense, business language.** `Suspended`, not `UpdateUserStatus`.
- **Data only:** ids and value objects. No entity, no closure, no `Arc`.
- **No `Serialize`.** Events hold value objects, which are never serialized (rule 17). The wire shape is `infra`'s job (§ 6), just as the row is.

### The entity records, the repository persists

The entity method that changes state also records the event. `restore` starts with no pending events: rehydrating is not something that happened.

```rust
// crates/domain/src/user/user_entity.rs (excerpt)
pub struct User {
    id: UserId,
    email: Email,
    is_suspended: bool,
    created_at: DateTime<Utc>,
    events: Vec<Recorded<UserEvent>>,
}

impl User {
    pub fn suspend(&mut self) -> Result<(), UserError> {
        if self.is_suspended {
            return Err(UserError::AlreadySuspended);
        }
        self.is_suspended = true;
        self.record(UserEvent::Suspended { user_id: self.id });
        Ok(())
    }

    /// Events recorded since the entity was created or restored.
    pub fn pending_events(&self) -> &[Recorded<UserEvent>] {
        &self.events
    }

    fn record(&mut self, event: UserEvent) {
        self.events.push(Recorded::new(event));
    }
}
```

The use case does not change: it calls `user.suspend()?` and `self.user_repo.save(&user).await?`, as it already does. It never sees a broker.

---

## 4. The outbox (default)

Saving the aggregate and publishing to a broker are two writes to two systems. If the use case does both, a crash between them either loses the event or publishes one for a change that was rolled back. The outbox makes the event part of the database write:

1. The repository's `save` writes the aggregate **and** one outbox row per pending event, in one transaction it opens itself (`use-cases-and-ports.md` § 9).
2. A relay, running in the background, reads unsent rows, sends them through the `Producer`, and marks them sent.

### Table

```sql
-- migrations/<ts>_outbox.sql
CREATE TABLE outbox (
    seq          BIGSERIAL   PRIMARY KEY,          -- relay order
    id           UUID        NOT NULL UNIQUE,      -- the event id: consumers dedup on it
    topic        TEXT        NOT NULL,
    message_key  TEXT        NOT NULL,             -- partition / ordering key
    kind         TEXT        NOT NULL,             -- "user.suspended.v1"
    payload      BYTEA       NOT NULL,
    occurred_at  TIMESTAMPTZ NOT NULL,
    sent_at      TIMESTAMPTZ
);
CREATE INDEX outbox_unsent ON outbox (seq) WHERE sent_at IS NULL;
```

### Writing it inside `save`

```rust
// crates/infra/src/repository/user/pg_user_repository.rs (excerpt)
async fn save(&self, user: &User) -> Result<(), AppError> {
    let mut tx = self.pool.begin().await.map_err(db_error)?;

    sqlx::query("INSERT INTO users (…) VALUES (…) ON CONFLICT (id) DO UPDATE SET …")
        /* .bind(..) */
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;

    for recorded in user.pending_events() {
        insert_outbox(&mut tx, &OutboundMessage::try_from(recorded)?).await?;
    }

    tx.commit().await.map_err(db_error)?;
    Ok(())
}
```

`insert_outbox` lives in `infra/messaging/outbox.rs`. The port keeps its canonical contract (rule 14): `save(&User)`, no extra parameter.

The in-memory repository keeps parity: it stores the pending events it was asked to save, so a use case test asserts on them (§ 10).

### The relay

```rust
// crates/infra/src/messaging/outbox_relay.rs
pub struct OutboxRelay {
    pool: PgPool,
    producer: Arc<dyn Producer>,
    batch_size: i64,
    idle: Duration,
}

impl OutboxRelay {
    pub async fn run(self, shutdown: CancellationToken) {
        while !shutdown.is_cancelled() {
            let sent = match self.relay_batch().await {
                Ok(sent) => sent,
                Err(e) => {
                    tracing::error!(error = %e, "outbox relay failed; backing off");
                    0
                }
            };
            if sent == 0 {
                tokio::select! {
                    () = shutdown.cancelled() => break,
                    () = tokio::time::sleep(self.idle) => {}
                }
            }
        }
    }

    async fn relay_batch(&self) -> Result<usize, AppError> {
        let mut tx = self.pool.begin().await.map_err(db_error)?;
        let rows = sqlx::query_as::<_, OutboxRow>(
            "SELECT id, topic, message_key, kind, payload, occurred_at FROM outbox
             WHERE sent_at IS NULL ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED",
        )
        .bind(self.batch_size)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_error)?;

        for row in &rows {
            // Stop at the first failure: later rows wait, so per-key order holds.
            self.producer.send(&OutboundMessage::from(row)).await?;
            sqlx::query("UPDATE outbox SET sent_at = now() WHERE id = $1")
                .bind(row.id)
                .execute(&mut *tx)
                .await
                .map_err(db_error)?;
        }

        tx.commit().await.map_err(db_error)?;
        Ok(rows.len())
    }
}
```

- **At-least-once.** A failure after `send` and before `commit` re-sends the batch. That is expected; consumers dedup (§ 9).
- **Keep batches small.** The transaction holds row locks while it talks to the broker.
- **Ordering.** One relay, ordered by `seq`, keeps per-key order. Several relays with `SKIP LOCKED` scale out but can reorder; accept that only when consumers do not depend on order.
- **Bound the table.** Delete or archive sent rows on a schedule (`../rust-patterns/architectural-principles.md` § 2, "bound anything that grows").
- **The relay never stops on an error.** It logs and backs off; the process exits only on shutdown.

---

## 5. Direct publish (the exception)

Publish straight from the use case **only when the publish is the use case's only write**: nothing is saved, so there is no second system to disagree with. Example: `RequestReportUseCase` whose whole effect is "report requested".

If the use case also saves, use the outbox. Publishing after `save` has no good failure mode: returning the error answers 500 for a change that was committed, and swallowing it loses the event.

The port is a feature trait like any other (`use-cases-and-ports.md` § 4):

```rust
// crates/domain/src/report/report_event_publisher.rs
#[async_trait]
pub trait ReportEventPublisher: Send + Sync {
    async fn publish(&self, event: &Recorded<ReportEvent>) -> Result<(), AppError>;
}
```

```rust
// usecase
let event = Recorded::new(ReportEvent::Requested { report_id, requested_by });
self.events.publish(&event).await?;
```

`infra/messaging/report/broker_report_event_publisher.rs` maps the event with the feature's `_message.rs` and calls the `Producer`. `in_memory_report_event_publisher.rs` records what it was given; the architecture check fails when the fake is missing.

---

## 6. The wire: `envelope.rs` and `<feature>_message.rs`

```rust
// crates/infra/src/messaging/envelope.rs
/// Broker-agnostic outbound message. Each producer maps it to its client's type.
#[derive(Debug, Clone)]
pub struct OutboundMessage {
    pub id: Uuid,                 // the event id → dedup key
    pub topic: String,            // Kafka topic / RabbitMQ exchange / NATS subject prefix / SQS queue or SNS topic
    pub key: String,              // ordering key: the aggregate id
    pub kind: String,             // "user.suspended.v1"
    pub payload: Vec<u8>,
    pub occurred_at: DateTime<Utc>,
}
```

The feature's mapping is the equivalent of `<feature>_row.rs`: wire structs plus one conversion.

```rust
// crates/infra/src/messaging/user/user_message.rs
const TOPIC: &str = "user.events";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UserRegisteredV1<'a> {
    user_id: String,
    email: &'a str,
    occurred_at: DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UserSuspendedV1 {
    user_id: String,
    occurred_at: DateTime<Utc>,
}

impl TryFrom<&Recorded<UserEvent>> for OutboundMessage {
    type Error = AppError;

    fn try_from(recorded: &Recorded<UserEvent>) -> Result<Self, AppError> {
        let occurred_at = recorded.occurred_at();
        let (kind, user_id, payload) = match recorded.event() {
            UserEvent::Registered { user_id, email } => (
                "user.registered.v1",
                user_id,
                serde_json::to_vec(&UserRegisteredV1 { user_id: user_id.to_string(), email: email.as_str(), occurred_at }),
            ),
            UserEvent::Suspended { user_id } => (
                "user.suspended.v1",
                user_id,
                serde_json::to_vec(&UserSuspendedV1 { user_id: user_id.to_string(), occurred_at }),
            ),
        };
        Ok(Self {
            id: recorded.id().as_uuid(),
            topic: TOPIC.to_owned(),
            key: user_id.to_string(),
            kind: kind.to_owned(),
            payload: payload.map_err(AppError::unexpected)?,
            occurred_at,
        })
    }
}
```

- **The payload is a published contract** with other services, versioned in `kind` (`.v1`). Add fields; never rename, retype or reuse one. A breaking change is a new kind (`.v2`), published alongside the old one until consumers move.
- **Consumers tolerate unknown fields**: no `#[serde(deny_unknown_fields)]` on inbound payloads.
- **Topic names are `infra` constants** (or `Config` values when they differ per environment), never strings in a use case.
- **JSON by default.** Avro or Protobuf with a schema registry is a project decision; the mapping file is where it changes.
- **Large payloads** (SQS caps at 256 KB, Kafka defaults to 1 MB): store the data and send a reference.

---

## 7. Producers, one per broker

`infra/messaging/producer.rs` declares the broker-agnostic trait the relay and the publishers use. It is internal to `infra`, not a domain port:

```rust
#[async_trait]
pub trait Producer: Send + Sync {
    /// Returns once the broker has accepted the message.
    async fn send(&self, message: &OutboundMessage) -> Result<(), AppError>;
}
```

Each implementation turns client errors into `AppError::unexpected` at the edge (`R3`), and **waits for the broker's acknowledgment**: a send that returns before the broker has the message is not a send.

### Kafka — `kafka_producer.rs` (`rdkafka`)

```rust
pub struct KafkaProducer {
    producer: FutureProducer,
    timeout: Duration,
}

impl KafkaProducer {
    pub fn new(brokers: &str) -> Result<Self, AppError> {
        let producer = ClientConfig::new()
            .set("bootstrap.servers", brokers)
            .set("enable.idempotence", "true") // implies acks=all
            .create()
            .map_err(AppError::unexpected)?;
        Ok(Self { producer, timeout: Duration::from_secs(5) })
    }
}

#[async_trait]
impl Producer for KafkaProducer {
    async fn send(&self, m: &OutboundMessage) -> Result<(), AppError> {
        let id = m.id.to_string();
        let headers = OwnedHeaders::new()
            .insert(Header { key: "message-id", value: Some(id.as_str()) })
            .insert(Header { key: "type", value: Some(m.kind.as_str()) });
        let record = FutureRecord::to(&m.topic).key(&m.key).payload(&m.payload).headers(headers);
        self.producer
            .send(record, self.timeout)
            .await
            .map_err(|(e, _)| AppError::unexpected(e))?;
        Ok(())
    }
}
```

The key is the aggregate id, so every event of one aggregate lands on one partition, in order.

### RabbitMQ — `rabbitmq_producer.rs` (`lapin`)

```rust
pub struct RabbitMqProducer {
    _connection: Connection, // dropping it closes the channel
    channel: Channel,
}

impl RabbitMqProducer {
    pub async fn connect(url: &str) -> Result<Self, AppError> {
        let connection = Connection::connect(url, ConnectionProperties::default())
            .await
            .map_err(AppError::unexpected)?;
        let channel = connection.create_channel().await.map_err(AppError::unexpected)?;
        channel
            .confirm_select(ConfirmSelectOptions::default()) // publisher confirms
            .await
            .map_err(AppError::unexpected)?;
        Ok(Self { _connection: connection, channel })
    }
}

#[async_trait]
impl Producer for RabbitMqProducer {
    async fn send(&self, m: &OutboundMessage) -> Result<(), AppError> {
        let properties = BasicProperties::default()
            .with_message_id(m.id.to_string().into())
            .with_kind(m.kind.clone().into())
            .with_delivery_mode(2); // persistent
        let confirmation = self
            .channel
            .basic_publish(&m.topic, &m.kind, BasicPublishOptions::default(), &m.payload, properties)
            .await
            .map_err(AppError::unexpected)?
            .await
            .map_err(AppError::unexpected)?;
        if confirmation.is_nack() {
            return Err(AppError::unexpected(format!("broker refused message {}", m.id)));
        }
        Ok(())
    }
}
```

`topic` is a durable topic exchange and `kind` the routing key, so a consumer binds its queue to `user.suspended.*` or `user.#`. Declare exchanges, queues, bindings and dead-letter exchanges at startup (a `rabbitmq_topology.rs` called from `main.rs`) or in infrastructure-as-code; agree which with the user.

### NATS JetStream — `nats_producer.rs` (`async-nats`)

```rust
pub struct NatsProducer {
    jetstream: jetstream::Context,
}

#[async_trait]
impl Producer for NatsProducer {
    async fn send(&self, m: &OutboundMessage) -> Result<(), AppError> {
        let mut headers = HeaderMap::new();
        headers.insert("Nats-Msg-Id", m.id.to_string().as_str()); // server-side dedup window
        headers.insert("type", m.kind.as_str());
        self.jetstream
            .publish_with_headers(format!("{}.{}", m.topic, m.kind), headers, m.payload.clone().into())
            .await
            .map_err(AppError::unexpected)? // sent
            .await
            .map_err(AppError::unexpected)?; // stored by the stream
        Ok(())
    }
}
```

Publish through **JetStream**, never core `client.publish`: core NATS keeps nothing when no subscriber is listening.

### SQS — `sqs_producer.rs` (`aws-sdk-sqs`)

```rust
pub struct SqsProducer {
    client: aws_sdk_sqs::Client,
    queue_url: String,
}

#[async_trait]
impl Producer for SqsProducer {
    async fn send(&self, m: &OutboundMessage) -> Result<(), AppError> {
        let body = String::from_utf8(m.payload.clone()).map_err(AppError::unexpected)?;
        self.client
            .send_message()
            .queue_url(&self.queue_url)
            .message_body(body)
            .message_group_id(&m.key)                   // FIFO queues: per-key order
            .message_deduplication_id(m.id.to_string()) // FIFO queues: dedup window
            .send()
            .await
            .map_err(AppError::unexpected)?;
        Ok(())
    }
}
```

SQS is a queue, not a topic: one queue feeds one consumer service. For several consumers, publish to an **SNS topic** (`aws-sdk-sns`, an `sns_producer.rs`) with one SQS queue subscribed per service. Drop the two FIFO calls on a standard queue.

`aws_config::load_defaults(..)` reads `AWS_*` variables and files itself. Call it in `app` (`main.rs`), next to `Config::from_env()`, so every environment dependency stays visible at the composition root (rule 2); pass the built `Client` down.

### `in_memory_producer.rs`

Records every message in a `Mutex<Vec<OutboundMessage>>`. Relay and publisher tests run on it.

---

## 8. Consumers

A consumer is an inbound adapter, the twin of an HTTP handler: it turns a message into an Input and calls one use case.

### The consumer file

```rust
// crates/infra/src/messaging/notification/send_welcome_email_consumer.rs
/// Wire shape of `user.registered.v1`, as this service reads it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRegisteredPayload {
    user_id: String,
    email: String,
}

pub async fn send_welcome_email_consumer(
    send_welcome_email: Arc<SendWelcomeEmailUseCase>,
    message: InboundMessage,
) -> Result<(), ConsumeError> {
    let payload: UserRegisteredPayload = message.json()?;
    send_welcome_email
        .execute(SendWelcomeEmailInput {
            message_id: message.id,
            user_id: payload.user_id,
            email: payload.email,
        })
        .await?;
    Ok(())
}
```

Same rules as a handler (rule 16): one `pub async fn` named after the file, it drives exactly one use case, and **no error handling**: no `match` on the result, no `map_err`, no `Err(..)`. `message.json()` fails with `ConsumeError::Malformed`; `?` turns an `AppError` into `ConsumeError::App`. The architecture check flags the rest (`consumer-shape`, `consumer-no-error-mapping`).

### The central mapper: `disposition.rs`

The equivalent of `HttpError`: the only place that decides what a result means to the broker.

```rust
pub enum Disposition { Ack, Retry, DeadLetter }

#[derive(Debug)]
pub enum ConsumeError {
    /// The payload did not have the expected shape. Retrying cannot fix it.
    Malformed(String),
    App(AppError),
}

impl From<AppError> for ConsumeError { /* Self::App */ }

pub fn disposition_of(result: &Result<(), ConsumeError>) -> Disposition {
    match result {
        Ok(()) => Disposition::Ack,
        Err(ConsumeError::Malformed(_)) => Disposition::DeadLetter,
        Err(ConsumeError::App(e)) => match e.kind() {
            ErrorKind::Unexpected => Disposition::Retry,
            ErrorKind::Invalid
            | ErrorKind::NotFound
            | ErrorKind::Conflict
            | ErrorKind::Unauthenticated
            | ErrorKind::Forbidden => Disposition::DeadLetter,
        },
    }
}
```

| Result | Disposition | Why |
|---|---|---|
| `Ok` | Ack | Done |
| Malformed payload | Dead-letter | The same bytes will fail again |
| `ErrorKind::Unexpected` (database down, timeout) | Retry, with backoff | Transient |
| Any other `ErrorKind` | Dead-letter | A business rejection; retrying gives the same answer |

**Retries are bounded.** The subscriber reads the attempt count (a header, the broker's delivery count, or SQS `ApproximateReceiveCount`) and turns `Retry` into `DeadLetter` past the limit. Log every dead-letter with its cause (`tracing::error!`).

### Subscribers: one receive loop per broker

`infra/messaging/<broker>_subscriber.rs` receives, builds an `InboundMessage { id, kind, key, payload, attempt }`, calls the consumer, maps the result with `disposition_of`, and acknowledges:

| | Ack | Retry | Dead-letter |
|---|---|---|---|
| **Kafka** | Commit the offset **after** handling (`enable.auto.commit=false`) | No per-message nack: publish to `<topic>.retry` with the attempt count, then commit | Publish to `<topic>.dlq`, then commit |
| **RabbitMQ** | `basic_ack` | `basic_nack` without requeue into a retry queue whose TTL dead-letters back (delayed retry) | `basic_reject` without requeue → the dead-letter exchange |
| **NATS JetStream** | `ack` | `ack_with(AckKind::Nak(Some(delay)))`; cap with the consumer's `max_deliver` | `ack_with(AckKind::Term)`, then publish to a `.dlq` subject |
| **SQS** | `delete_message` | Do not delete; `change_message_visibility` for backoff | Redrive policy: `maxReceiveCount` moves it to the DLQ |

- **Bound in-flight work**: RabbitMQ `basic_qos` prefetch, JetStream `max_ack_pending`, a bounded Kafka poll. Nothing reads faster than it can handle.
- **Do not hold a `std::sync::Mutex` across `.await`** in a loop (`../rust-patterns/ownership-clone-and-smart-pointers.md` C6).
- Kafka: a retry topic gives up per-key order for the retried message. If order matters, retry in place with backoff and accept that the partition waits.

---

## 9. Idempotency

Every broker here may deliver a message twice, and the relay may send one twice. A consumer must produce the same result the second time.

In order of preference:

1. **Naturally idempotent use cases.** An upsert keyed by the source id, or an entity method that is a no-op when the state is already reached.
2. **The message id in the Input** (`message_id` above), stored by the aggregate's own `save` (an entity field such as `last_applied_event`, or a dedup row written in the same transaction), so a repeat is detected inside the write it would duplicate.

A separate "processed messages" check before the use case is a second write in another transaction and has the same gap as § 4. Agree on the approach with the user.

---

## 10. Composition root

```rust
// crates/app/src/main.rs (excerpt)
let shutdown = CancellationToken::new();

// Producer: the one broker the project chose
let producer: Arc<dyn Producer> = Arc::new(KafkaProducer::new(&config.kafka_brokers)?);

// Outbox relay
let relay = tokio::spawn(OutboxRelay::new(pool.clone(), producer.clone()).run(shutdown.clone()));

// Consumers: one subscription per consumer, as routes are one per handler
let send_welcome_email = Arc::new(SendWelcomeEmailUseCase::new(mailer));
let subscriber = tokio::spawn(run_kafka_subscriber(
    kafka_consumer(&config.kafka_brokers, &config.service_name, &["user.events"])?,
    producer.clone(), // for retry and dead-letter topics
    shutdown.clone(),
    move |message| send_welcome_email_consumer(send_welcome_email.clone(), message),
));

axum::serve(listener, router)
    .with_graceful_shutdown(shutdown_signal(shutdown.clone()))
    .await?;
shutdown.cancel();
relay.await?;
subscriber.await??;
```

- Broker URLs, credentials, the consumer group or queue name come from `Config` (rule 2), passed through constructors.
- The relay and subscribers stop on the same shutdown signal as the server, finish the message in hand, and acknowledge it before exiting.
- A service that only consumes is still this binary without the router; the layout does not change.
- When different deployments use different brokers, put each client behind a Cargo feature in `infra` (`kafka = ["dep:rdkafka"]`) so a build compiles only one.

---

## 11. Tests

- **Use case:** unchanged, on the in-memory repository. Assert on the events it saved (`repo.saved_events()`), not on a broker.
- **Mapping:** `<feature>_message.rs` gets a test pinning the JSON of each kind. It is a contract with other services; a diff in that test is a breaking change.
- **Consumer:** build an `InboundMessage` by hand, call the consumer with its use case on fakes, assert the `disposition_of` result.
- **Relay:** run one batch against a test database and the `InMemoryProducer`.
- **Against a real broker:** in the crate's `tests/` folder (containers or a shared environment). Out of scope for this skill, as database tests are.

---

## 12. Common pitfalls

- **`save` then `publish` in the use case.** A dual write. Use the outbox (§ 4).
- **`#[derive(Serialize)]` on a domain event.** Map it in `<feature>_message.rs`.
- **A broker client in `domain` or `usecase`.** `[forbidden-crate]`. The domain records; `infra` sends.
- **Business logic in a consumer**, or a consumer that matches on errors. One Input, one `execute`, `?`.
- **Acknowledging before handling.** Kafka `enable.auto.commit=true` (the default), RabbitMQ `no_ack: true`: a crash loses the message.
- **Unbounded redelivery.** RabbitMQ `requeue: true` or a JetStream `Nak` with no `max_deliver` spins on a poison message forever.
- **Assuming exactly-once or global order.** Order is per partition, queue, subject or FIFO group, and only for the key you chose.
- **Core NATS for events that matter.** Use JetStream.
- **Reading broker settings in an adapter.** `config.rs` reads them; `aws_config` is called in `app`.
- **Topic names in a use case.** They belong to `infra`.
- **A `static` producer or connection.** Build it in `main` and inject it (rule 11).

---

## Cross-references

- `use-cases-and-ports.md` — § 4 ports (the publisher port), § 9 multiple writes and the outbox.
- `infra-axum-sqlx.md` — handlers and `HttpError` (the inbound twin of consumers and `disposition.rs`), repositories, composition root.
- `domain-modeling.md` — entities, `AppError` and `ErrorKind`.
- `workspace-layout.md` — the `infra/messaging/` tree and the naming table.
- `../rust-patterns/behavioral-patterns-keeping-track.md` § 4 (Observer as domain events), `../rust-patterns/behavioral-patterns-actions.md` § 4 (Mediator), `../rust-patterns/architectural-principles.md` (downward flow, contained mutation, bounded growth).
