# Backend Implementation Plan — Final / Frozen / Implementation-Ready

**Status**: IMPLEMENTATION-READY. This is the corrected, normalized plan produced by integrating the Backend Freeze Audit's findings directly into the original implementation plan. Every P0 and P1 the freeze audit identified has been resolved in place below — there are no "see audit" pointers, no stale wording left beside corrected wording, and no open TODOs. Where an item required an actual engineering decision rather than a pure normalization (the `pending_transactions` table's disposition, the `GraceToken` offline-budget model), the decision has been made explicitly and is recorded in §21 (Design Decision Register) rather than left hanging.

**Scope**: Backend only (auth, licensing, payment, sessions, authorization, revocation, file transfer, audit, admin, background jobs, persistence, observability, deployment). Control Plane (CP), Execution Plane (EP), and Frontend are out of scope and appear only as **Backend Contract Dependencies** (§23).

**Source of truth**: this document is self-contained. It began as a synthesis of `backend_core_specification.md` ("Core Spec") and `hostile_audit_report.md` ("Hostile Audit"), and was then itself put through a hostile internal-consistency ("freeze") audit; every correction that audit identified has been folded directly into the sections below, so no external document needs to be consulted to implement from this plan. Protocol is **v2** throughout, with an explicit v1 compatibility shim during migration (Phase 4).

**On the "Core Spec §X" / "Hostile Audit CRIT/EV/B/etc." citations that remain throughout this document** (Freeze Audit P2-1): these are retained deliberately, as **provenance annotations**, not as pointers to content an implementer needs to go find. In every case, the rule, schema, or behavior being cited is fully and independently specified in the surrounding text at the point of citation — the citation exists so a reader can trace *why* a given design choice was made (which finding motivated it) without that trace being load-bearing for *implementing* it. The only citations that were genuinely dangling — referring to source-document section numbers with no equivalent content anywhere in this plan (e.g. an earlier draft's "§33.6", "§36.8", "§36.9" in Phase 20, and "Hostile Audit Part IV") — have been replaced below with the actual inlined content they were standing in for.

---

## 0. How This Plan Is Organized

1. §1–2: reconstructed architecture and module boundaries (what to build)
2. §3: every open conflict/decision, resolved (so phases below don't re-litigate them)
3. §4: Phases 0–21, dependency-ordered, each implementation-grade
4. §5–§19: consolidated cross-cutting specs (schema, transactions, crypto, protocol, providers, errors, audit, admin, jobs, config, observability, deployment, versioning, testing) — referenced *from* the phases rather than duplicated inside each one
5. §20: target repository layout (no existing Backend repo was supplied, so this is greenfield — file/module mapping, not a diff)
6. §21: Design Decision Register
7. §22: Requirements Traceability Matrix
8. §23: Backend Contract Dependencies (everything Backend must provide *to* CP, without implementing CP)
9. §24: Definition of Done

---

## 1. Backend Component Map

```text
Backend
│
├── Security Gateway         — envelope construction/validation, signature verify, replay guard
├── Crypto Module             — Ed25519 (domain-separated), AES-256-GCM, Argon2id, HKDF
├── Protocol Module           — canonical serialization, generation/epoch validation, v1/v2 compat
├── Machine Identity Registry — registration, verification, clone detection
├── Authentication Module     — credential validation, lockout, session bootstrap
├── Session Management        — lifecycle, renewal, generation tracking, revocation
├── Authorization Engine      — capability resolution/grant/revoke
├── Licensing/Entitlement     — license lifecycle, tier mapping, LicensingProvider port
├── Keygen Adapter            — LicensingProvider implementation (isolated)
├── Payment Module            — checkout, webhook processing, subscription lifecycle
├── Payment Adapter           — PaymentProvider implementation (isolated)
├── Revocation Service        — cascade logic, circuit breaker, REVOCATION_NOTICE
├── File Transfer Service     — chunked upload lifecycle, hash verification, storage
├── Audit & Observability     — security events, hash chain, redaction, retention
├── Application Service Layer — cross-domain orchestration (NEW — resolves MB-01 cycle)
├── Outbox Worker              — durable async delivery to Keygen/Payment/Revocation (NEW — CRIT-03)
├── Persistence Layer          — connection pool, transaction management, migrations
├── Admin Boundary              — separate auth path, RBAC, dangerous-op safeguards
└── Configuration/Secrets       — registry, env/secrets-manager loading
```

This differs from the Core Spec's component list in two ways, both required by the Hostile Audit:

- **Application Service Layer** added (EV‑16 / MB‑01): domain modules were found to have a forbidden dependency cycle (Authentication → Licensing, while Licensing must not depend on Authentication). Cross-domain workflows (e.g. "authenticate" touching Auth + Machine + Licensing + Authorization + Session + Audit) are extracted into orchestrating `AppService.*` functions that call domain modules; domain modules never call each other directly.
- **Outbox Worker** added (EV‑03 / CRIT‑03 / B‑01): every external call (Keygen, payment provider, revocation delivery) that must be causally linked to a DB commit goes through a durable outbox table + async worker, never a synchronous external call inside (or unguarded outside) a DB transaction.

### 1.1 Component Responsibility Table

| Component | Responsibility | Owned State | Inputs | Outputs | Depends On | Forbidden Deps | External Integrations |
|---|---|---|---|---|---|---|---|
| Security Gateway | Envelope build/validate, replay guard | `server_nonces` | Protocol Envelope | Validated request / rejection | Crypto, Machine Registry | Licensing, Payment, Admin, FTS | — |
| Crypto Module | Sign/verify/hash/encrypt | Active signing key (in-memory, sourced from KMS) | Plaintext/ciphertext, keys | Signatures, hashes | KMS/HSM adapter | Any domain module | KMS/HSM |
| Protocol Module | Canonical JSON, generation/epoch/timestamp validation | — (stateless) | Envelope fields | Validated/normalized envelope | Crypto | Licensing, Payment, Admin | — |
| Machine Identity Registry | Registration, verification, clone detection | `machines` | Registration request | `machine_id`, verification result | Crypto, Audit, Persistence | Session, Auth, Licensing | — |
| Authentication Module | Credential check, lockout, session bootstrap trigger | `accounts` (read/write lockout fields) | `AUTH_INIT` | Auth result | Persistence, Crypto, Audit | Payment, Admin, FTS, Keygen/Payment adapters directly | — |
| Session Management | Session lifecycle | `sessions` | Session ops | Session state | Machine Registry, Persistence, Audit | Licensing, Payment, FTS | — |
| Authorization Engine | Capability resolution | `authorizations` | Session + license state | `AuthorizationRecord` | Session, Machine, Licensing, Persistence, Audit | Payment, Keygen, FTS | — |
| Licensing/Entitlement | License lifecycle, tier mapping | `licenses` | License ops | `LicenseRecord` | `LicensingProvider` port, Persistence, Audit | Payment (directly), Session, Auth, Machine, Admin, FTS, Keygen (directly) | Keygen (via adapter only) |
| Keygen Adapter | Implements `LicensingProvider` | Keygen API client state | Adapter calls | Keygen results | Keygen API | Any other Backend module | Keygen CE |
| Payment Module | Checkout, webhook, subscription | `subscriptions`, `payment_events` | Webhooks, checkout requests | License-affecting events (via outbox) | `PaymentProvider` port, Licensing, Persistence, Audit | Session, Auth, Machine, Authorization, Admin, FTS | Payment provider (via adapter only) |
| Payment Adapter | Implements `PaymentProvider` | Provider SDK state | Adapter calls | Provider results | Payment provider SDK | Any other Backend module | Stripe/etc. |
| Revocation Service | Cascade + circuit breaker | Circuit-breaker counters | Revocation triggers | `REVOCATION_NOTICE` (via outbox) | Session, Authorization, Machine Registry, Licensing, Persistence, Audit | Payment (directly), Authentication | — |
| File Transfer Service | Chunked transfer lifecycle | `file_transfers`, `file_transfer_chunks` | FTS requests | Transfer state, stored object | Session, Authorization, Persistence, Storage Adapter | Licensing, Payment, Machine Registry, Authentication | Object storage |
| Audit & Observability | Event persistence, hash chain | `security_events` | Domain events | Persisted, chained events | Persistence | **every** domain module (audit is a sink) | — |
| Application Service Layer | Cross-domain orchestration | — (stateless) | Controller calls | Orchestrated results | All domain modules | Protocol Envelope construction (that's Security Gateway's job) | — |
| Outbox Worker | Durable async external delivery | `outbox_events` | Outbox rows | External calls + DB follow-up txn | Persistence, Keygen Adapter, Payment Adapter, Revocation Service | Any synchronous request path | Keygen, Payment provider, CP delivery channel |
| Persistence Layer | Pool, transactions, migrations | Connections | Queries | Results | DB driver | Any domain module | PostgreSQL |
| Admin Boundary | Admin auth, RBAC, dangerous-op safeguards | `admin_users`, `admin_sessions` | Admin API calls | Admin results | All domain modules (calls them) | Protocol Envelope, CP communication | — |
| Configuration/Secrets | Registry, validated env loading | Runtime config | Env vars/secrets manager | Typed config | Secrets manager | — | Secrets manager |

---

## 2. Module Dependency Matrix

| Module | May Depend On | Must Not Depend On | Owns |
|---|---|---|---|
| Security Gateway | Crypto, Machine Registry | Licensing, Payment, Admin, FTS | `server_nonces` |
| Crypto | KMS/HSM adapter (leaf) | Any domain module | Signing key lifecycle |
| Protocol | Crypto | Licensing, Payment, Admin | — |
| Authentication | AppService (not domain modules directly), Session, Machine, Licensing (read-only via AppService), Crypto, Audit | Payment, Admin, FTS, Keygen/Payment adapters | `accounts` |
| Machine Registry | Crypto, Audit, Persistence | Session, Authorization, Licensing, Payment, Admin | `machines` |
| Session | Machine Registry, Persistence, Audit | Licensing, Payment, Admin, FTS, Keygen/Payment adapters | `sessions` |
| Authorization | Session, Machine Registry, Licensing, Persistence, Audit | Payment, Keygen, Payment adapters, Admin, FTS | `authorizations` |
| Licensing | `LicensingProvider` port, Persistence, Audit | Payment (directly), Session, Authentication, Machine Registry, Admin, FTS, Keygen (directly) | `licenses` |
| Keygen Adapter | Keygen SDK/HTTP client | Any other Backend module | — |
| Payment | `PaymentProvider` port, Licensing, Persistence, Audit, Outbox | Session, Authentication, Machine Registry, Authorization, Admin, FTS | `subscriptions`, `payment_events` |
| Payment Adapter | Provider SDK | Any other Backend module | — |
| Revocation | Session, Authorization, Machine Registry, Licensing, Persistence, Audit, Outbox | Payment (directly), Authentication | Circuit-breaker state |
| FTS | Session, Authorization, Persistence, Storage Adapter | Licensing, Payment, Machine Registry, Authentication | `file_transfers`, `file_transfer_chunks` |
| Audit | Persistence | Every domain module | `security_events` |
| AppService | All domain modules | — (this is the one place cross-calls are allowed) | — |
| Outbox Worker | Persistence, Keygen Adapter, Payment Adapter, Revocation delivery channel | Any synchronous request path | `outbox_events` |
| Admin | All domain modules (as caller) | Protocol Envelope, CP communication | `admin_users`, `admin_sessions` |

No cycles: the only bidirectional-looking relationship in the Core Spec (Authentication ↔ Licensing, flagged MB‑01/HIGH) is resolved by routing the "authenticate → resolve license → compute authorization → create session" workflow through `AppService.authenticate()`, which calls each domain module once, in order, and none of the domain modules call each other.

---

## 3. Resolved Conflicts and Decisions (Applied Throughout This Plan)

Every `CONFLICT — REQUIRES RESOLUTION`, `UNSPECIFIED — REQUIRES DECISION`, and Hostile Audit `DEC-*`/blocking condition is resolved here so the phases in §4 can be implementation-grade without re-litigating them. Full register with alternatives considered is in §21.

| # | Conflict/Decision | Resolution Applied | Source |
|---|---|---|---|
| 1 | Canonical JSON: object vs array | **Object**, explicit key order `version → msgId → generation → timestamp → epoch → server_epoch → payload` (v2) / `version → msgId → generation → epoch → payload` (v1 compat) | DEC-01, CRIT-02 |
| 2 | Dual-signing during key rotation | Envelope carries `signatures: Record<key_version, hex_signature>` (v2), not a single `signature` string | CRIT-01 |
| 3 | Missing replay timestamp | Add `timestamp: uint64` (ms epoch) to envelope, included in canonical serialization | CRIT-06 |
| 4 | DB restore misclassified as forgery | Add `server_epoch: uint64`, stored **outside** the Postgres backup boundary; compared alongside generation counters | CRIT-05 |
| 5 | Audit hash chain fork under concurrency | `accounts.last_event_hash` column, `SELECT … FOR UPDATE` serializes event insertion per account | CRIT-07 |
| 6 | Payment → Keygen atomicity | Transactional Outbox pattern (`outbox_events`), all Keygen/payment/revocation-delivery calls are async and idempotency-keyed | CRIT-03 |
| 7 | Offline grace locally manipulable | Backend-signed `GraceToken` with `not_after` (single absolute deadline — see DEC-17), capability-specific TTLs; CP-side enforcement is a Backend Contract Dependency (§23) | CRIT-04, EV-20 |
| 8 | Authoritative capability set (CP's 4 vs canonical's 7) | **Union** of both sets; tier→capability mapping is configuration-driven, not hardcoded | DEC-02 |
| 9 | Concurrent session policy | Single active session per machine; multiple machines per account allowed | DEC-03 |
| 10 | Revocation delivery mechanism | Piggyback (fallback, always available) + WebSocket push (real-time) hybrid, delivered via Outbox Worker | DEC-04, EV-19 |
| 11 | File storage backend | Configurable `StorageAdapter` port; default local filesystem for dev, S3-compatible for prod | DEC-05 |
| 12 | Initial generation counter value | **1**, not 0 | DEC-06 |
| 13 | Implementation language | TypeScript / Node.js | DEC-07 |
| 14 | Database | PostgreSQL | DEC-08 |
| 15 | Signing key storage | Pluggable KMS/HSM adapter port; default AWS KMS (swap via config, not code, for other environments) | DEC-09 |
| 16 | Plan/tier definitions | BASE / PRO / ENTERPRISE as specified in Core Spec §17.3, capabilities from the union set (#8) | DEC-10 |
| 17 | Envelope payload encryption beyond TLS | TLS 1.3 only for MVP; no additional AEAD payload layer (no clear threat-model benefit over TLS, adds complexity) | DEC-11 |
| 18 | CP guard fields (`nonceValidated`, `responseValidated`, `backendConfirmed`, `nonceChecked`) absent from Backend response schemas | Backend **must** include these exact fields in the relevant response payloads — this is a Backend-side fix, not a CP fix | CP-08, P-04, EV-17 |
| 19 | `generation_states` conflates account- and machine-scoped counters | Split into `account_generation_states` (license_revision), `machine_session_states` (session_generation, authorization_revision, machine_generation), and a global `backend_trust_state` (server_trust_version, cross-referencing the external server_epoch) | B-07, DB-04, EV-15 |
| 20 | Backend schema includes CP-only states | Trim `sessions.status` (drop `NO_SESSION`, `AUTHENTICATING`; add `PARTIAL`) and `machines.status` (drop `UNINITIALIZED`, `GENERATING`, `CREATED`) | B-08, B-09, B-11, SM-02, SM-03 |
| 21 | FTS resume via single `lastAckedChunkIndex` | Replace with `acked_chunks: [[start,end], …]` range bitmap to support parallel chunk uploads | FT-01, EV-09 |
| 22 | No entitlements table despite being a named concept | Model entitlement as a **configuration-driven plan→capability/limit mapping** (`plan_entitlements`), not a per-account row; `licenses.capabilities`/`limits` remain the account-level materialized result | DB-03 |
| 23 | Session credential = long-lived machine key (no forward secrecy) | Backend supports an ephemeral ECDHE-derived per-session key alongside the long-lived Ed25519 identity key for payload confidentiality; identity key continues to authenticate | EV-11, S-02 |
| 24 | Circuit breaker state in-memory only | Persist circuit-breaker counters in `revocation_circuit_breaker` (fixed one-minute window, not a sliding/rolling window — see DEC-16) so a Backend restart doesn't silently reset protection | R-03 |
| 25 | `authorizations.license_id` and `revocation_circuit_breaker.overridden_by` forward-referenced tables not yet created at that point in the migration | Reorder migration (§5.1/§5.4): `plan_entitlements`/`licenses` before `authorizations`; `admin_users`/`admin_sessions` before `revocation_circuit_breaker`. `CREATE EXTENSION IF NOT EXISTS pgcrypto;` added as the migration's first statement, ahead of any `gen_random_uuid()` use | Freeze Audit P0-1, P0-2, P0-7 |
| 26 | Outbox `PROCESSING` rows had no way to recover from a worker crash | Added `claimed_at`, `lease_expires_at`, `worker_id` to `outbox_events`; claim via `SELECT … FOR UPDATE SKIP LOCKED`; stale-lease sweep reclaims rows whose lease expired | Freeze Audit P0-3 |
| 27 | `/payments/checkout` cannot be both "no synchronous provider calls" and a working checkout endpoint | Narrowed the invariant to "no code path that **mutates license/authorization/subscription state** calls a provider synchronously" — checkout-session creation is a synchronous, idempotency-keyed, state-mutation-free provider call | Freeze Audit P0-4 |
| 28 | "Keygen is write-only" contradicted the `LicensingProvider` port's own read methods and the `license-sync` job | Backend DB is authoritative for the authorization-decision path (never calls Keygen inline there); Keygen read methods are called only by `license-sync` (background) and Admin reconciliation; write methods only via the Outbox Worker | Freeze Audit P0-5 |
| 29 | Authorization Resolution was shown advancing `license_revision`, a read operation mutating account-scoped state it doesn't own | `license_revision` advances only in the License Change transaction; Authorization Resolution reads and stamps it, never increments it | Freeze Audit P0-6 |

---

## 4. Implementation Phases

Dependency-ordered. Phases in the same tier can run in parallel; later tiers depend on all phases in earlier tiers being complete. See §19 for the full dependency graph.

### Phase 0 — Repository & Runtime Foundation

**Objective**: Bootstrap the TypeScript/Node.js Backend repo with the target layout (§20), lint/build/test tooling, and CI skeleton.
**Prerequisites**: DEC-07 (TypeScript), DEC-08 (PostgreSQL) accepted.
**Components**: none (infra only).
**Files/Directories**: full tree per §20.1 (greenfield — no existing Backend repo supplied).
**Database Changes**: none.
**Interfaces**: none.
**API Changes**: none.
**Protocol Changes**: none.
**State Changes**: none.
**Transactions**: none.
**External Services**: none.
**Security Requirements**: dependency-scanning enabled in CI from day 1; no secrets committed (pre-commit secret scanner).
**Failure Handling**: n/a.
**Tests**: CI runs `lint` + `typecheck` + `test` on empty scaffold.
**Completion Criteria**: `npm run build && npm test` succeeds on a scaffold with no domain code; CI pipeline green.

### Phase 1 — Configuration & Secrets

**Objective**: Implement the typed configuration registry (§14) and secrets loading.
**Prerequisites**: Phase 0.
**Components**: Configuration/Secrets.
**Files**: `src/config/index.ts`, `src/config/schema.ts`.
**Database Changes**: none.
**Interfaces**: `loadConfig(): Config` — validates all env vars against schema at startup; process exits non-zero on missing/invalid required values (esp. `DATABASE_URL`, `KEYGEN_API_KEY`, `PAYMENT_WEBHOOK_SECRET`).
**API Changes**: none.
**Protocol Changes**: none.
**State Changes**: none.
**Transactions**: none.
**External Services**: secrets manager (env vars for MVP; adapter interface so a vault/KMS-backed secrets provider can be swapped in later without code change).
**Security Requirements**: Critical/High-sensitivity values (§14 registry) never logged, never read from repo config files — env/secrets-manager only, per Core Spec §30 IMPORTANT note.
**Failure Handling**: fail-fast on startup if required config missing; do not start HTTP server.
**Tests**: unit tests for schema validation (reject missing `DATABASE_URL`, reject out-of-range `SESSION_LIFETIME_MS`, etc.).
**Completion Criteria**: all 26 config values in §14 registry are typed, validated, defaulted, and range-checked at startup.

### Phase 2 — Database & Migration Infrastructure

**Objective**: Stand up PostgreSQL connection pooling, transaction helpers, and the migration runner; land the full corrected schema (§5) as migration `001_initial_schema.sql`.
**Prerequisites**: Phase 1.
**Components**: Persistence Layer.
**Files**: `src/persistence/connection.ts`, `src/persistence/transaction.ts`, `migrations/001_initial_schema.sql`.
**Database Changes**: full schema from §5, in the **verified migration order** given there (§5.4's "Verified migration order" line) — `pgcrypto` extension first, then `plan_entitlements`/`licenses` before `authorizations`, then `admin_users`/`admin_sessions` before `revocation_circuit_breaker`, then every other table in the order listed. This order is load-bearing, not incidental: it is the difference between a migration that runs and one that fails on its first `CREATE TABLE`.
**Interfaces**: `withTransaction<T>(isolationLevel, fn: (tx) => Promise<T>): Promise<T>` helper enforcing the canonical lock order (§6.4) on every multi-table transaction.
**API Changes**: none.
**Protocol Changes**: none.
**State Changes**: none (schema only).
**Transactions**: migration runner itself runs inside a transaction; idempotent (safe to re-run).
**External Services**: PostgreSQL.
**Security Requirements**: destructive migrations (column/table drops) require a manual `--allow-destructive` flag (§16.4).
**Failure Handling**: startup blocks on migration failure; no partial schema state (migrations wrapped in transactions where the DDL allows it).
**Tests**: migration test applies `001_initial_schema.sql` to a genuinely empty PostgreSQL database (no `pgcrypto` pre-installed, no tables pre-existing) and asserts (a) the migration completes without error, (b) every table from §5 exists, (c) every foreign key constraint from §5 exists and resolves, (d) every index from §5 exists, (e) re-running the migration is a no-op. This exact test is what would have caught the original schema's forward-reference and missing-extension issues immediately — it is the first thing written and run in this phase, before any application code depends on the schema.
**Completion Criteria**: fresh, genuinely empty DB + `npm run migrate` produces the full schema on the first attempt, with no manual intervention or reordering; `withTransaction` helper unit-tested for rollback-on-throw.

### Phase 3 — Cryptographic Foundation

**Objective**: Implement Ed25519 sign/verify with domain separation, AES-256-GCM, Argon2id, HKDF, and the KMS/HSM key-access adapter.
**Prerequisites**: Phase 1.
**Components**: Crypto Module.
**Files**: `src/crypto/ed25519.ts`, `src/crypto/aead.ts`, `src/crypto/hashing.ts`, `src/crypto/keys.ts`, `src/crypto/kms-adapter.ts`.
**Database Changes**: `backend_keys` table (already in §5).
**Interfaces**:
```typescript
sign(keyVersion: number, message: Buffer): Promise<string>       // hex, 128 chars
verify(publicKeyHex: string, message: Buffer, sigHex: string): boolean
hashPassword(plaintext: string): Promise<string>                  // Argon2id
verifyPassword(plaintext: string, hash: string): Promise<boolean> // constant-time
encrypt(key: Buffer, plaintext: Buffer, aad?: Buffer): {nonce, ciphertext, tag}
decrypt(key: Buffer, nonce, ciphertext, tag, aad?: Buffer): Buffer
```
**API Changes**: none.
**Protocol Changes**: none — this phase provides primitives Phase 4 consumes.
**State Changes**: `backend_keys` row lifecycle `GENERATED → ACTIVE → ROTATION_PENDING → ROTATED → RETIRED → DESTROYED` (+ `KEY_COMPROMISED` from any active state).
**Transactions**: key-state transitions are single-row DB updates; the private key material itself is **never** persisted in Postgres (KMS/HSM only), only `key_id`, `key_version`, `public_key_hex`, `status`.
**External Services**: KMS/HSM (pluggable adapter — DEC-09).
**Security Requirements**: INV-01 (always sign with the pinned key), INV-02 (domain separation `b"CONTROL_PLANE_V1"` mandatory on every Ed25519 op), INV-15 (Argon2id only, params: memory ≥ 64 MiB, iterations ≥ 3, parallelism ≥ 1), INV-16 (private keys never in logs/errors/responses).
**Failure Handling**: if KMS is unreachable, signing calls fail closed → callers return `503 SERVICE_UNAVAILABLE` (never send an unsigned response — INV-01); cache the active public key + a short-TTL in-memory reference to reduce KMS round-trips per the Hostile Audit's Reliability Engineer finding (single-signing-key outage risk), with secure wipe on shutdown.
**Tests**: golden-vector test — sign known message with known key, compare byte-for-byte; unit test proving signature differs with/without domain prefix; Argon2id hash format assertion (`$argon2id$…`); constant-time password comparison test.
**Completion Criteria**: all crypto primitives implemented and unit-tested against RFC 8032 Ed25519 test vectors; key rotation state machine implemented (used starting Phase 4).

### Phase 4 — Protocol & Envelope (v2, with v1 compatibility)

**Objective**: Implement the Protocol Envelope v2 (§8), canonical serialization, generation/epoch/timestamp validation, and v1 acceptance during migration.
**Prerequisites**: Phase 3.
**Components**: Protocol Module, Security Gateway.
**Files**: `src/protocol/envelope.ts`, `src/protocol/canonical.ts`, `src/protocol/replay-guard.ts`, `src/protocol/generation.ts`, `src/protocol/v1-compat.ts`.
**Database Changes**: `server_nonces` table (§5).
**Interfaces**:
```typescript
buildEnvelope(payload, generation, keyVersions: number[]): ProtocolEnvelopeV2   // multi-sign
validateEnvelope(raw): { valid: boolean; envelope?; error? }                    // sig + replay + version
checkGenerationCounter(scope, presented: bigint, stored: bigint): 'MATCH'|'CLIENT_BEHIND'|'FORGERY_SUSPECTED'
```
**API Changes**: this phase changes the *transport contract* for every subsequent envelope-carrying endpoint (Phases 7–11, 13, 17). It does not itself add HTTP routes.
**Protocol Changes**: implements the full v2 envelope from §8, including `timestamp`, `server_epoch`, and `signatures` map; a `version === 1` envelope is transcoded to the v2 validation path with `timestamp` and `server_epoch` checks skipped (documented, time-boxed exception — removed once `MIN_PROTOCOL_VERSION` is raised to 2 per §17.3).
**State Changes**: none.
**Transactions**: nonce insertion is a single-row `INSERT`; on unique-violation, reject as `NONCE_REPLAYED` (no transaction needed beyond the insert itself).
**External Services**: none.
**Security Requirements**: INV-06 (reject generation > stored → `GENERATION_COUNTER_FORGERY`), INV-07 (detect generation < stored → `GENERATION_MISMATCH`, force reconciliation), CRIT-06 (timestamp window ±30s), CRIT-05 (server_epoch comparison — see algorithm in §6.5), P-05 (must-ignore semantics: unknown envelope fields are preserved/ignored, not rejected, forward-compatible parsing).
**Failure Handling**: malformed envelope → `400`; expired timestamp → `NONCE_EXPIRED` (retryable with fresh nonce); replayed nonce → `403 NONCE_REPLAYED` (not retryable).
**Tests**: contract test — byte-for-byte canonical JSON match against a fixture representing the CP's actual `envelope.mjs` output (this fixture MUST be generated by running the real CP code, not guessed); replay tests (fresh/duplicate/expired nonce); generation forgery/rollback tests; v1/v2 dual-acceptance test.
**Completion Criteria**: Protocol module passes all contract tests in §17.3; nonce purge job wired (Phase 14 implements the scheduler, this phase implements the query).

### Phase 5 — Machine Identity

**Objective**: Machine registration, verification, and clone detection.
**Prerequisites**: Phase 4.
**Components**: Machine Identity Registry.
**Files**: `src/domain/machine/service.ts`, `src/domain/machine/repository.ts`, `src/domain/machine/clone-detector.ts`, `src/domain/machine/types.ts`.
**Database Changes**: `machines` table (trimmed status enum per §3 item 20: `REGISTERED, VERIFIED, CORRUPTED, REPLACEMENT_REQUIRED, RE_VERIFICATION_REQUIRED, REVOKED`).
**Interfaces**: `register(installationId, publicKeyHex, descriptor, selfSignature, authenticatedSessionId): MachineRecord`, `verify(machineId, requestSignature): boolean`, `detectClone(installationId, publicKeyHex): CloneVerdict`.
**API Changes**: `POST /machines/register` (§7.2).
**Protocol Changes**: registration payload is a Protocol Envelope; special-cased signature verification (§7.2 note: Backend doesn't have the pubkey yet, verifies using the pubkey *in* the request, then stores it).
**State Changes**: machine state machine per Core Spec §7.2, trimmed (CP-only pre-registration states removed per B-09).
**Transactions**: `READ COMMITTED`; single-row insert + `machine_generation` init.
**External Services**: none.
**Security Requirements**: **S-01 fix (EV-08)** — registration MUST require an already-authenticated session (`installationId` + self-signature alone is not sufficient); binding registration to `session.account_id` prevents an attacker from registering a stolen `installation_id` under their own account. INV-08 (auth required), INV-09 (pubkey verified on every subsequent authenticated request).
**Failure Handling**: duplicate `(installation_id, public_key_hex)` → idempotent, return existing `machine_id` (§13.7 race); same `installation_id`, different `public_key_hex` → `CLONE_SUSPECTED`, policy `FLAG_AND_GRACE` on first occurrence, `REQUIRE_REVERIFICATION` on repeat (§15.3).
**Tests**: registration idempotency test; clone-suspected test; unauthenticated-registration-rejected test (`INV-08`).
**Completion Criteria**: all Core Spec §15 flows implemented; clone policy configurable (`FLAG_AND_GRACE` default).

### Phase 6 — Security Gateway Hardening (Signed Errors, Guard Fields)

**Objective**: Close CP-08/P-04 (guard fields) and the Hostile Audit's Protocol Engineer finding (signed error responses) before any endpoint that returns them ships.
**Prerequisites**: Phase 4.
**Components**: Security Gateway.
**Files**: `src/api/middleware/envelope-validator.ts`, `src/api/middleware/error-handler.ts`.
**Database Changes**: none.
**Interfaces**: `wrapSignedError(code, message): ProtocolEnvelopeV2` — every error returned on an envelope-carrying route is itself a signed envelope, never a bare unsigned JSON error.
**API Changes**: cross-cutting middleware, not a route.
**Protocol Changes**: every response payload that a specific CP guard checks (§3 item 18) MUST literally include that field:
| Response | Required Field | Consuming CP Guard |
|---|---|---|
| `AUTH_RESULT` | `nonceValidated: true` | `AUTHENTICATING → AUTHENTICATED` |
| `SESSION_RENEW_RESULT` | `responseValidated: true` | renewal success |
| `AUTHORIZATION_RESULT` | `backendConfirmed: true` | authorization applied |
| `REVOCATION_NOTICE` | `nonceChecked: true` | revocation applied |
**State Changes**: none.
**Transactions**: none.
**External Services**: none.
**Security Requirements**: **HIGH — Hostile Audit "Signed error responses"**: unsigned errors let a MITM inject fake `SESSION_REVOKED`/etc. to force degraded state; non-envelope endpoints (payment webhook, admin) are exempt since they're not signature-authenticated the same way.
**Failure Handling**: if signing the error itself fails (KMS down) → plain `503` with no envelope (documented exception — there is nothing to forge when the whole channel is down).
**Tests**: contract test per response type asserting the exact guard field name/value is present; security test — unsigned error injection is rejected by a (simulated) CP-side verifier.
**Completion Criteria**: every envelope-carrying route in Phases 7–11, 13, 17 uses this middleware; no route hand-rolls its own envelope construction.

### Phase 7 — Authentication

**Objective**: `AUTH_INIT` flow, credential storage, lockout, rate limiting, partial-authentication path.
**Prerequisites**: Phases 3, 4, 5, 6.
**Components**: Authentication Module, Application Service Layer (`AppService.authenticate`).
**Files**: `src/domain/auth/service.ts`, `src/domain/auth/repository.ts`, `src/app/authenticate.ts` (AppService), `src/api/routes/auth.ts`, `src/api/middleware/rate-limiter.ts`.
**Database Changes**: `accounts` table (+ `lockout_expires_at` per EV-13/B-04 correction — replaces ambiguous single `lockout_until` naming with the corrected schema in §5).
**Interfaces**: `AppService.authenticate(username, password, machineId | null, protocolVersion, clientNonce): AuthResult` — orchestrates Auth → Machine (if machineId given) → Licensing (read) → Authorization (compute) → Session (create) → Audit (log), calling each domain module exactly once, per §2's cycle resolution.
**API Changes**: `POST /auth/init` (§7.1): request/response/errors/rate-limits exactly as Core Spec §12.1, response additionally carries `nonceValidated: true` (Phase 6) and a `GraceToken` (Phase 9 dependency — see note below; if Phase 9 isn't complete yet, ship without `GraceToken` and add it in Phase 9's follow-up migration of this route).
**Protocol Changes**: `AUTH_INIT` / `AUTH_RESULT` messages (§7.7).
**State Changes**: account lockout state machine (Core Spec §7.1); session creation is `NO_SESSION →` *(no Backend row yet)* `→ AUTHENTICATED` or `→ PARTIAL` (unregistered machine, §14.5).
**Transactions**: `SERIALIZABLE`. The full sequence (Freeze Audit P1-6 — this is now the authoritative transaction, not just "creates a session"):
```
BEGIN (SERIALIZABLE);
  SELECT * FROM accounts WHERE email = $1 FOR UPDATE;          -- §6.4 lock order step 1
  -- credential check, lockout check happen here, against the locked account row
  SELECT * FROM machines WHERE machine_id = $2 FOR UPDATE;     -- lock order step 2 (only if machineId given)
  UPDATE sessions SET status = 'REVOKED'
    WHERE machine_id = $2 AND status = 'AUTHENTICATED';        -- retire any existing session for this machine
  UPDATE machine_session_states SET session_generation = session_generation + 1
    WHERE machine_id = $2;                                     -- advance generation exactly once, whether or
                                                                -- not a prior session existed to retire
  INSERT INTO sessions (..., status) VALUES (..., 'AUTHENTICATED');   -- new session, new session_id
  INSERT INTO authorizations (...) VALUES (...);                -- computed from current license state (read-only)
  INSERT INTO security_events (..., event_type, reason) VALUES
    (..., 'LOGIN_SUCCESS', NULL),
    (..., 'SESSION_REVOKED', 'superseded_by_new_authentication')  -- only if a prior session was actually retired
COMMIT;
```
This makes re-authentication **safe to retry** (not idempotent-by-key — a fresh `session_id` is issued every time — but safe: repeating the sequence always converges to exactly one `AUTHENTICATED` session for the machine, per DEC-03's partial unique index, which the explicit revoke-then-replace order here satisfies without ever hitting a uniqueness violation). A retried `AUTH_INIT` after a lost response simply retires-and-replaces again; a CP that cached the prior `session_id` locally and hasn't yet learned about the replacement will correctly see `SESSION_REVOKED` on its next use of the old ID — this is expected, not an error condition.
**External Services**: none directly (no live Keygen call on the authentication hot path — the authorization-decision path never calls Keygen, per §9.1's authority model; Licensing reads only from Backend's own `licenses` table here).
**Security Requirements**: INV-15 (Argon2id), account lockout exponential backoff (1m/5m/15m/1h/24h), rate limits (5/account/15min, 20/IP/15min), **B-10 fix**: lockout counter increment is a single atomic `UPDATE accounts SET lockout_count = lockout_count + 1 …` (not read-then-write) to close the race the audit flagged.
**Failure Handling**: account not found → generic `AUTH_FAILED` (no user enumeration); locked → `423 ACCOUNT_LOCKED`; unregistered machine → `PARTIAL` session, authorization deferred until `MACHINE_REGISTER` (§14.5).
**Tests**: full auth flow integration test; lockout threshold test; concurrent-authentication-same-machine test (two simultaneous `AUTH_INIT` calls for the same machine — assert exactly one `AUTHENTICATED` session exists afterward, the other is `REVOKED`, and neither call errors on a uniqueness violation); rate-limit enforcement test.
**Completion Criteria**: `AppService.authenticate` implements the revoke-then-replace sequence above exactly, with the module-cycle fix from §2; partial-auth path (§14.5) implemented; concurrent-authentication test passes without any uniqueness-constraint error surfacing to a caller.

### Phase 8 — Session Management

**Objective**: Session creation (folded into Phase 7's `AppService.authenticate`), renewal, expiration, revocation, generation tracking.
**Prerequisites**: Phase 7.
**Components**: Session Management.
**Files**: `src/domain/session/service.ts`, `src/domain/session/repository.ts`, `src/api/routes/sessions.ts`.
**Database Changes**: `sessions` table (trimmed status enum, §3 item 20), `machine_session_states` (§3 item 19).
**Interfaces**: `renew(sessionId, machineId, presentedGenerationState, clientNonce): RenewalResult`, `revoke(sessionId, reason): void`, `logout(sessionId, machineId): void`.
**API Changes**: `POST /sessions/renew` (§7.3 — includes `responseValidated: true` from Phase 6), `POST /sessions/logout` (§7.4, idempotent).
**Protocol Changes**: `SESSION_RENEW` / `SESSION_RENEW_RESULT` messages.
**State Changes**: session state machine (Core Spec §7.3, trimmed).
**Transactions**: renewal pseudocode exactly as Core Spec §10 ("Session Renewal Transaction Pseudocode"), updated for the split generation tables (lock `machine_session_states` row, not the old combined `generation_states`); `SERIALIZABLE`.
**External Services**: none.
**Security Requirements**: single-session-per-machine (DEC-03) enforced at creation; INV-03/INV-04 (monotonic counters, same-transaction increment); logout is terminal (§13.11 race).
**Failure Handling**: renewal on expired/revoked session → `401`; generation mismatch → `403 GENERATION_MISMATCH`, forces reconciliation (Phase 15); lost-response-retry storm mitigated by the fact reconciliation (Phase 15) is cheap and idempotent, not by protocol change (Hostile Audit accepts this as "heavy but safe").
**Tests**: concurrent renewal test (only one succeeds per generation), revocation-during-renewal race test (§13.1, both interleavings), logout-vs-renewal race test (§13.11).
**Completion Criteria**: session state machine fully implemented and race-tested per §13's 14 documented races that touch sessions.

### Phase 9 — Licensing / Entitlements (+ GraceToken issuance)

**Objective**: License lifecycle, Keygen adapter (behind the port), tier mapping, causal linkage with Authorization, and Backend-signed `GraceToken` issuance (closes CRIT-04).
**Prerequisites**: Phases 3, 4, 8.
**Components**: Licensing/Entitlement, Keygen Adapter.
**Files**: `src/domain/licensing/service.ts`, `src/domain/licensing/provider.ts` (port), `src/domain/licensing/repository.ts`, `src/adapters/keygen/adapter.ts`, `src/domain/licensing/grace-token.ts`.
**Database Changes**: `licenses` (with EV-13 corrections: `machine_binding`, `effective_at`, `revoked_at`, `keygen_license_id`, `last_verified_at`), `plan_entitlements` (new — config-driven plan→capability/limit mapping, resolves DB-03), `account_generation_states` (§3 item 19).
**Interfaces**: `LicensingProvider` port, split by caller as specified in §9.1 — write methods (`createLicense`, `revokeLicense`, `suspendLicense`, `reactivateLicense`, `activateMachine`, `deactivateMachine`, `changePlan`) called only by the Outbox Worker; read methods (`validateLicense`, `getMachineCount`, `getEntitlements`, `checkEntitlement`) called only by `license-sync` (Phase 17) and Admin (Phase 13); `issueGraceToken(accountId, machineId, capabilities, riskTier): GraceToken`.
**API Changes**: `POST /licenses/validate` (§7.6).
**Protocol Changes**: `LICENSE_REQUEST`/`LICENSE_RESULT` messages; `GraceToken` structure exactly as §8.4 (no `max_offline_budget_ms` — removed per Freeze Audit P1-5), included in `AUTH_RESULT` and `SESSION_RENEW_RESULT` payloads (retrofit Phase 7/8 responses once this phase lands).
**State Changes**: license state machine (Core Spec §7.5) — all writes go through the Outbox Worker (Phase 10), never a synchronous Keygen call from the request path. **Backend's `licenses` table is sole authority for authorization decisions** (§9.1) — Keygen read methods exist and are used (by `license-sync` and Admin only), so "Keygen is write-only" is not the correct framing; the precise invariant is "Keygen is never consulted on the request-time authorization-decision path," which is narrower and is the one that actually matters.
**Transactions**: causal linkage invariant (§6.3): `license_revision` and `authorization_revision` co-advance in one transaction **only in this phase's License Change flow** — Authorization Resolution (Phase 11) reads `license_revision` and stamps it onto the returned record but never advances it (Freeze Audit P0-6; see §6.1's corrected table). If a License Change transaction fails to co-advance both counters, force `SECURITY_STATE_UNCERTAIN`.
**External Services**: Keygen CE — write methods **only** via the Outbox Worker (Phase 10), never inline; read methods only via `license-sync` (Phase 17) and Admin (Phase 13), never inline on the authorization path.
**Security Requirements**: INV-05 (causal linkage — License Change only), INV-14 (Keygen strictly behind the port — architecture test: no direct Keygen import outside `adapters/keygen/`; a second architecture test, per §9.1, additionally asserts the four read methods are never imported from `src/domain/authorization/` or `src/domain/auth/`). `GraceToken` capability-specific TTLs (EV-20): e.g. `CAP_AUTOMATION_START`-class capabilities get short `not_after` (hours), read-only capabilities get long/no `not_after` — see §9.3 tier→TTL table.
**Failure Handling**: Keygen unreachable → Backend continues serving every authorization decision from its own `licenses` table unaffected (§9.1's fallback); adapter retries with backoff, circuit-breaks on repeated `5xx`; `license-sync` skips its tick rather than failing hard if Keygen is unreachable.
**Tests**: causal-linkage unit test (co-advance on License Change, and violation-detection); **regression test for P0-6**: repeated `authorization/resolve` calls against an unchanged license leave `licenses.license_revision` unchanged (assert the exact value before and after N calls); Keygen-adapter contract test (mocked Keygen API); GraceToken signature/expiry unit tests (no `max_offline_budget_ms` field present); architecture test asserting no module outside `adapters/keygen/` imports the Keygen SDK, and a second asserting the read/write method split by caller.
**Completion Criteria**: Three-Concept Model (Entitlement/License/Authorization) implemented with `plan_entitlements` as the entitlement layer; GraceToken issuance wired into auth/renewal responses; the P0-6 regression test passes.

### Phase 10 — Outbox Worker & Payment Integration

**Objective**: Transactional Outbox pattern (closes CRIT-03/B-01) and the payment provider integration built on top of it.
**Prerequisites**: Phases 2, 9.
**Components**: Outbox Worker, Payment Module, Payment Adapter.
**Files**: `src/outbox/worker.ts`, `src/outbox/repository.ts`, `src/domain/payment/service.ts`, `src/domain/payment/provider.ts` (port), `src/domain/payment/webhook-handler.ts`, `src/adapters/payment/adapter.ts`, `src/api/routes/payments.ts`.
**Database Changes**: `outbox_events` (with `claimed_at`, `lease_expires_at`, `worker_id` — Freeze Audit P0-3), `payment_events`, `subscriptions`.
**Interfaces**: `enqueue(type, payload, idempotencyKey): void` (called inside the same transaction as the triggering write); `claim(workerId): OutboxEvent | null` (the lease-aware claim query below); `PaymentProvider` port (`createCheckoutSession`, `createSubscription`, `cancelSubscription`, `changeSubscriptionPlan`, `verifyWebhookSignature`, `createCustomer`, `getCustomer`).
**API Changes**: `POST /payments/checkout` (synchronous provider call, no Backend state mutation — see below), `POST /payments/webhook` (§7.10 — plain HTTPS, not Protocol Envelope, drives the async outbox flow).
**Protocol Changes**: none (payment endpoints are explicitly non-envelope).
**State Changes**: `outbox_events.status`: `PENDING → PROCESSING → DELIVERED | FAILED`, with `PROCESSING` rows reclaimable back to `PENDING` on lease expiry (below); subscription state machine (Core Spec §7.6); the full pipeline `Payment Event → Entitlement Change → License Update → Authorization Update` — payment status never directly gates a CP operation (INV-13).

**Two distinct payment flows, explicitly separated** (Freeze Audit P0-4 — this phase's original completion criterion, "no HTTP handler ever calls a provider synchronously," was incompatible with checkout actually working, since the HTTP response to `/payments/checkout` *is* the provider's answer):

1. **Checkout initiation** (`POST /payments/checkout`) — calls `createCheckoutSession`/`createCustomer`/`getCustomer` **synchronously**, inline in the request handler, to obtain a checkout URL/session/client-secret to return to the caller. This mutates **no** Backend entitlement state (no write to `licenses`, `authorizations`, or `subscriptions`) — see §6.1's "Payment Checkout Initiation" row. It is idempotent via a client-supplied or account-derived `Idempotency-Key` forwarded to the provider (§6.3), so a retried checkout request returns the same provider-side session rather than creating a duplicate.
2. **Entitlement/subscription mutation** (triggered by `POST /payments/webhook`) — remains fully asynchronous via the outbox, exactly as originally specified: (1) verify signature, (2) `BEGIN; INSERT payment_events; INSERT outbox_events; COMMIT` and return `200` immediately, (3) async worker claims the event and calls Keygen/updates license with the idempotency key, (4) worker commits license/authorization/generation-state changes in one transaction. Outbox events for the same `account_id` are processed **sequentially** (advisory lock on `account_id`) to prevent an outbox-ordering issue where two events for one account are picked up out of enqueue order by concurrent worker instances.

**Outbox claim and lease mechanism** (Freeze Audit P0-3 — this is what makes the entitlement-mutation flow's async processing actually crash-recoverable):
```sql
UPDATE outbox_events
SET status = 'PROCESSING', claimed_at = now(), lease_expires_at = now() + interval '2 minutes', worker_id = $1
WHERE event_id = (
  SELECT event_id FROM outbox_events
  WHERE (status = 'PENDING' AND next_attempt_at <= now())
     OR (status = 'PROCESSING' AND lease_expires_at < now())   -- stale-lease reclaim: a prior worker died
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```
If the reclaimed row's `attempts >= max_attempts` after incrementing, it is instead set to terminal `FAILED` (poison-event handling) and an admin alert fires — it is never left in `PROCESSING` indefinitely and never retried forever.

**External Services**: payment provider (synchronous for checkout initiation; async, via the outbox, for webhook-driven changes), Keygen (via Phase 9's adapter, invoked *by* the worker, write methods only).
**Security Requirements**: INV-19 (webhook signature verified before any processing), `payment_events.provider_event_id` UNIQUE (dedup), refund/chargeback → license `REVOKED` cascade (Phase 12), checkout-initiation calls never write `licenses`/`authorizations`/`subscriptions` (enforced by code review + the architecture test below, since this is the one place a provider call is deliberately synchronous and it must not become a backdoor for entitlement mutation).
**Failure Handling**: crash after outbox insert, before worker claims it → row stays `PENDING`, worker picks it up on next poll; crash after worker claims (`PROCESSING`), before completion → lease expires, stale-lease reclaim above returns it to `PENDING` (or `FAILED` past `max_attempts`) — **this is the fix for the scenario that previously had no recovery path**; crash after external call succeeds, before delivery mark → retried worker call is itself idempotency-keyed at Keygen/provider, and the DB follow-up is idempotent; crash during checkout initiation, before the HTTP response reaches the caller → caller retries with the same `Idempotency-Key`, provider returns the same checkout session; worker starvation (process died entirely, not just one claimed row) → health check monitors `outbox_events` queue depth *and* the count of `PROCESSING` rows with an expired lease, alerts if either exceeds threshold, worker is supervisor-managed (systemd/PM2) for auto-restart.
**Tests**: the "Payment Webhook Crash Timeline" integration test, asserted **not** to duplicate a license; webhook duplicate-delivery test; outbox-ordering test (two events for one account processed in enqueue order even under concurrent worker pickup); **crash-recovery regression test for P0-3**: kill the worker process mid-`PROCESSING` (after claim, before provider call completes), assert the row's lease expires and it is reclaimed and successfully retried by a fresh worker instance, with the underlying license created/updated exactly once; poison-event test (an event that always fails reaches `FAILED` at `max_attempts`, not an infinite retry loop); checkout-idempotency test (retried checkout request with the same `Idempotency-Key` returns the same provider session).
**Completion Criteria**: no code path that **mutates license, authorization, or subscription state** calls Keygen or the payment provider synchronously from an HTTP request handler — those calls are enqueued and processed by the worker. Checkout-session creation (and other read-only/session-establishing provider calls: `createCustomer`, `getCustomer`) **is** made inline, is idempotency-keyed, and is verified by an architecture/integration test to never itself write to `licenses`/`authorizations`/`subscriptions`. A worker killed mid-`PROCESSING` never permanently wedges an event.

### Phase 11 — Authorization

**Objective**: Capability resolution and grant/revoke, evaluated independently of what the CP claims.
**Prerequisites**: Phases 8, 9.
**Components**: Authorization Engine.
**Files**: `src/domain/authorization/service.ts`, `src/domain/authorization/capability-registry.ts`, `src/domain/authorization/repository.ts`, `src/api/routes/authorization.ts`.
**Database Changes**: `authorizations` (+ `license_id` FK per EV-14/B-06, enabling targeted cascade instead of blanket session-scoped revocation; + `observed_license_revision`, a read-only stamp of the license revision seen at resolve time — §5.1).
**Interfaces**: `resolve(sessionId, machineId, presentedGenerationState): AuthorizationRecord`, `revoke(authorizationId, reason): void`.
**API Changes**: `POST /authorization/resolve` (§7.5 — includes `backendConfirmed: true` from Phase 6).
**Protocol Changes**: `AUTHORIZATION_REQUEST`/`AUTHORIZATION_RESULT`.
**State Changes**: authorization state machine (Core Spec §7.4).
**Transactions**: `READ COMMITTED`, serializing on the `licenses` row (`SELECT … FOR UPDATE`) to avoid granting on a stale license read — the lock exists **only** to guarantee a consistent read, never to justify a write to that row (Freeze Audit P0-6). `resolve()` writes `authorizations` (including stamping `observed_license_revision = licenses.license_revision` as read) and advances `machine_session_states.authorization_revision` by exactly 1. It **never** writes `licenses` or advances `account_generation_states.license_revision` — that counter changes only in Phase 9/10's License Change transaction. This is now enforced by a regression test (below), not just documented.
**External Services**: none.
**Security Requirements**: capability-to-tier mapping uses the **union** set (§3 item 8) resolved via `plan_entitlements` (Phase 9), not hardcoded; INV-05 (causal linkage — the License Change side of it; Authorization Resolution observes and stamps, it does not participate in the co-advance).
**Failure Handling**: session invalid/machine invalid/license invalid/capability absent/generation inconsistent → `DENIED` with specific reason; machine `REVOKED` → deny.
**Tests**: capability-per-tier resolution test (BASE/PRO/ENTERPRISE against the union set); race test for Authorization Resolution vs. License Revocation (the `licenses` row lock resolves this without granting on a stale read); property test — authorization is never `VALID` for a session that isn't `AUTHENTICATED`; **regression test for P0-6** (shared with Phase 9): calling `resolve()` repeatedly against an unchanged license leaves `licenses.license_revision` bit-for-bit unchanged across all calls, while `authorization_revision` advances on every call.
**Completion Criteria**: `resolve()` never trusts CP-presented capability claims — always recomputed server-side from current license + machine + session state — and never mutates `license_revision` under any code path.

### Phase 12 — Revocation

**Objective**: Cascade logic, circuit breaker (now persisted), `REVOCATION_NOTICE` construction and delivery via the Outbox Worker.
**Prerequisites**: Phases 8, 9, 10, 11.
**Components**: Revocation Service.
**Files**: `src/domain/revocation/service.ts`, `src/domain/revocation/circuit-breaker.ts`.
**Database Changes**: `revocation_circuit_breaker` (persists a **fixed one-minute window** revocation counter — not a rolling/sliding window; see below — so a restart doesn't reset protection, closing R-03).
**Interfaces**: `revoke(scope: 'ACCOUNT'|'MACHINE'|'SESSION'|'LICENSE', targetId, reason): void` — internally builds and atomically applies the full cascade, then enqueues a `REVOCATION_NOTICE` outbox event.
**API Changes**: consumed by Admin routes (Phase 13) and internally by Payment/Licensing (Phase 9/10) on suspend/refund/chargeback.
**Protocol Changes**: `REVOCATION_NOTICE` message, carrying `nonceChecked: true` (Phase 6) and the updated generation counters/`server_epoch`.
**State Changes**: cascades exactly as specified (account → machines → sessions → authorizations → file transfers; machine → sessions → authorizations; session → authorization; license → authorizations → sessions), all within **one** DB transaction (INV-21).
**Transactions**: `SERIALIZABLE`, full cascade atomic; canonical lock order (§5.4) enforced to avoid deadlock across the wide fan-out.

**Circuit breaker: fixed one-minute window, not rolling** (Freeze Audit P1-2/DEC-16 — an earlier draft described this in prose as a "rolling" counter while the schema implemented a fixed window; the schema is kept as-is, the prose is corrected to match it, since a fixed-window counter is materially simpler to reason about under concurrency than a true sliding-window log and that simplicity was the actual design intent). `window_start` identifies the current window via `date_trunc('minute', now())`; `revocation_count` increments transactionally alongside each revocation's cascade commit; the breaker trips (`tripped = true`) when `revocation_count >= CIRCUIT_BREAKER_THRESHOLD` (default 10) within the current window. **Accepted boundary behavior**: a burst of revocations clustered right at a window boundary can, in the worst case, allow up to 2× the threshold before tripping (some in the tail of one window, some in the head of the next) — this is a known, accepted tradeoff for implementation simplicity, not an oversight. Multiple Backend instances share protection correctly because the counter lives in Postgres, not in per-process memory — every instance increments the same row for the current window. Override requires `SUPER_ADMIN` + justification, logged as `CIRCUIT_BREAKER_OVERRIDDEN`.

**Revocation delivery is best-effort by design, not the security mechanism** (Freeze Audit P1-12 — stated explicitly here so an implementer doesn't spend effort building acknowledgment-tracking that this design doesn't need): `REVOCATION_NOTICE` delivery (WebSocket push, piggyback fallback, DEC-04) is an optimization that shortens the window before a revoked CP stops attempting operations — it is **never** the mechanism that makes revocation effective. Effectiveness comes entirely from the cascade above completing, atomically, in the database, *before* any notice is even attempted; a CP that never receives any notice at all — WebSocket down, push lost, CP offline for weeks — is still rejected on its very next request via the ordinary, independent session/authorization/machine status checks (INV-10), which are re-evaluated fresh against the DB on every request regardless of what the CP believes its own state to be. Outbox delivery attempts for `REVOCATION_NOTICE` are retried per the standard outbox retry policy (Phase 10) but are **not acknowledged** by the CP, and no additional delivery-state table (`PENDING`/`SENT`/`ACKNOWLEDGED` on the notice itself, as distinct from the outbox event's own `status`) is needed — building one would add complexity without changing the actual security guarantee, which doesn't depend on it.
**External Services**: delivery channel to CP (WebSocket push + piggyback fallback) — implemented as an outbox consumer, best-effort per above.
**Security Requirements**: INV-10 (revocation is immediate and terminal — no state machine transition leads *out* of `REVOKED`); mass-revocation circuit breaker, fixed one-minute window, default threshold 10, persisted (closes R-03); override requires `SUPER_ADMIN` + justification, logged as `CIRCUIT_BREAKER_OVERRIDDEN`.
**Failure Handling**: circuit breaker trips → revocations `HALT`, `CIRCUIT_BREAKER_TRIGGERED` event, admin must override or cancel; **residual risk, accepted under DEC-12**: even with a `GraceToken` (Phase 9), a fully network-partitioned CP retains whatever capability TTL its last `GraceToken` granted, and — per §8.4's documented consequence — an already-issued token remains valid until its own `not_after` even if the underlying machine/account is revoked during that window; this is bounded by capability-specific short TTLs, not eliminated, by deliberate design.
**Tests**: cascade-atomicity test (revoke account with N machines/sessions/authorizations, assert all-or-nothing); circuit-breaker threshold test, including restart-durability (kill and restart the process mid-window, counter persists in Postgres) and a boundary-burst test confirming the accepted up-to-2× behavior is bounded and not unbounded; multi-instance circuit-breaker test (two Backend instances both incrementing the same window's counter concurrently, trip fires at the correct combined count).
**Completion Criteria**: all revocation triggers wired to `revoke()`; circuit breaker state survives process restart and is shared correctly across multiple Backend instances; `REVOCATION_NOTICE` delivery has no acknowledgment-tracking infrastructure, by design.

### Phase 13 — Administration

**Objective**: Separate `/admin/*` auth path, RBAC, dangerous-operation safeguards.
**Prerequisites**: Phases 5, 7, 8, 9, 10, 11, 12 (admin calls into all of them).
**Components**: Admin Boundary.
**Files**: `src/admin/auth.ts`, `src/admin/routes.ts`, `src/admin/rbac.ts`, `src/admin/types.ts`.
**Database Changes**: `admin_users`, `admin_sessions` (already in §5).
**Interfaces**: role-gated route handlers per Core Spec §28.2 roles (`SUPER_ADMIN`, `LICENSE_ADMIN`, `SUPPORT`, `AUDIT`).
**API Changes**: all of Core Spec §7.11 (`GET /admin/accounts`, `POST /admin/accounts/:id/suspend`, `.../reinstate`, `POST /admin/machines/:id/revoke`, `POST /admin/sessions/:id/invalidate`, `POST /admin/licenses/:id/revoke`, `GET /admin/audit/events`, `POST /admin/circuit-breaker/override`).
**Protocol Changes**: none — INV-12: admin operations **never** flow through the Protocol Envelope.
**State Changes**: none beyond what the called domain services already define.
**Transactions**: delegates to the domain service's own transaction (e.g. `revoke()` from Phase 12); admin route itself just authenticates/authorizes/audits.
**External Services**: none directly.
**Security Requirements**: MFA (TOTP/WebAuthn) required on every admin login (INV-23); admin sessions 30 min, no renewal without re-auth; dangerous ops (Core Spec §28.3 table) require the listed additional safeguard (2-of-N approval for key rotation, 30-day soft delete before hard delete, etc.); admin session tokens never fixated — new token generated on every successful login (Hostile Audit "Admin session fixation" finding).
**Failure Handling**: `401 ADMIN_AUTH_REQUIRED` / `403 ADMIN_PERMISSION_DENIED`; circuit-breaker-active admin calls return `503 CIRCUIT_BREAKER_ACTIVE` unless overriding.
**Tests**: integration test — admin operation attempted via the CP auth path is rejected (INV-12); RBAC matrix test (each role can/cannot call each dangerous op); session-fixation test.
**Completion Criteria**: every dangerous operation in §28.3 enforces its listed safeguard; admin audit trail complete (every admin action individually logged with `admin_id`).

### Phase 14 — File Transfer Service

**Objective**: Chunked upload lifecycle, integrity verification, resume via range bitmap (closes FT-01).
**Prerequisites**: Phases 8, 11.
**Components**: File Transfer Service.
**Files**: `src/transfer/service.ts`, `src/transfer/repository.ts`, `src/adapters/storage/adapter.ts`.
**Database Changes**: `file_transfers` (+ `acked_chunks JSONB` per EV-09, replacing single-integer resume tracking), `file_transfer_chunks`.
**Interfaces**: `StorageAdapter` port (local filesystem default, S3-compatible for prod — DEC-05); `initialize()`, `uploadChunk()`, `complete()`, `cancel()`.
**API Changes**: `POST /transfers/initialize`, `POST /transfers/:remoteSessionId/chunks`, `POST /transfers/:remoteSessionId/complete`, `POST /transfers/:remoteSessionId/cancel`, `GET /transfers/:remoteSessionId/status` (§7.9), status response returns `acked_chunks` ranges instead of `lastAckedChunkIndex`.
**Protocol Changes**: FTS is non-envelope (session-token authenticated — machine-signature verification applies to Protocol Envelope requests; FTS requires session token + capability check on every request instead).
**State Changes**: transfer state machine.

**Authoritative vs. derived acknowledgment state** (Freeze Audit P1-3 — an earlier draft had two representations of "which chunks are acked" with no stated relationship between them): `file_transfer_chunks.acked` (a boolean on each per-chunk row) is **authoritative** — it is set exactly once per chunk, inside the same transaction as chunk storage, via `UPDATE … WHERE chunk_index = $1`. `file_transfers.acked_chunks` (the JSONB range list on the parent row) is a **derived, materialized cache**, recomputed — not incrementally patched — from `file_transfer_chunks` inside that same transaction, using one aggregate query that collapses the currently-acked `chunk_index` values into `[[start,end],…]` ranges. It exists solely so `GET /transfers/:id/status` can answer cheaply without scanning every chunk row. **Repair rule**: if the two are ever found inconsistent (a bug, a manual DB intervention), `file_transfer_chunks.acked` wins and `acked_chunks` is recomputed from it — never the reverse.

**Transactions**: `READ COMMITTED`; chunk upsert idempotent on `(transfer_id, chunk_index)`, recomputing `file_transfers.acked_chunks` in the same transaction per above; completion idempotent via status check. **Cancellation race fix** (Freeze Audit P2-5): every chunk-upload transaction re-checks `file_transfers.status = 'UPLOADING'` (inside its own transaction, not just at initialize) before writing the chunk row; if cancellation has already committed (`status = 'CANCELLED'`), the chunk write is rejected with `TRANSFER_CANCELLED` and no chunk state is committed — this closes the window where an in-flight chunk upload could otherwise write a row after the transfer was already cancelled.
**External Services**: configured storage backend.
**Security Requirements**: `CAP_FILE_UPLOAD` capability required; **confused-deputy fix**: every chunk upload verifies the `(session_id, remoteSessionId)` pair against the transfer's *creating* session, not just that *some* valid session presented the request; session + capability re-checked on every chunk, not just at initialize — session revoked or capability removed mid-transfer → transfer `CANCELLED`.
**Failure Handling**: chunk hash mismatch → `CHUNK_HASH_MISMATCH` (retryable, resend chunk); final hash mismatch → `TRANSFER_HASH_MISMATCH`, transfer `FAILED`; parallel chunk uploads of different indices are safe (no shared mutable state per chunk); chunk arriving after cancellation → `TRANSFER_CANCELLED`, no state committed (above).
**Tests**: parallel-chunk-upload test (uses `acked_chunks` ranges, asserts correct resume point with gaps, and that the derived `acked_chunks` always matches what `file_transfer_chunks.acked` would independently compute); chunk-hash-mismatch retry test; confused-deputy test (chunk upload with mismatched session/remoteSessionId rejected); cancellation-during-upload race test (chunk upload racing a concurrent cancellation — assert the chunk write loses if cancellation commits first, and no partial state is left behind either way).
**Completion Criteria**: resume works correctly with genuinely parallel, out-of-order chunk acknowledgment; the authoritative/derived relationship between `file_transfer_chunks.acked` and `file_transfers.acked_chunks` holds under concurrent chunk uploads; a chunk cannot be committed after its transfer has been cancelled.

### Phase 15 — Reconciliation

**Objective**: First-class, idempotent state reconciliation, including the Server Epoch check that distinguishes forgery from legitimate DB restore (closes CRIT-05).
**Prerequisites**: Phases 4, 8, 9, 11.
**Components**: spans Protocol, Session, Authorization, Licensing (reads only) — implemented as its own service per Core Spec's module list, orchestrated via AppService.
**Files**: `src/domain/reconciliation/service.ts`, `src/app/reconcile.ts`.
**Database Changes**: none beyond what Phase 2 already created; introduces the `backend_trust_state`/external `server_epoch` store as a **read** dependency (see §5.3 for where `server_epoch` actually lives).
**Interfaces**: `reconcile(machineId, clientGenerationState, clientServerEpoch): ReconciliationResult`.
**API Changes**: `POST /reconciliation` (§7.7).
**Protocol Changes**: `SECURITY_STATE_REQUEST`/`SECURITY_STATE_RESULT`.
**State Changes**: none as a rule (INV-11: read-only comparison, no mutation unless genuinely diverged) — but see Failure Handling for the one legitimate mutation path (forced reconciliation writing corrected state back only when the *server* was wrong, never to paper over a client anomaly).
**Transactions**: `READ COMMITTED`, but reads under `FOR UPDATE` when comparing against a row that could be concurrently revoked (§13.8 race) so the response is always the authoritative state *at commit time*.
**External Services**: none.
**Security Requirements**: implements the corrected per-counter algorithm from Hostile Audit CRIT-05 — **not** the Core Spec §23.4 version, which is the one the audit found bricks the CP fleet after a routine DB restore:
```
if client_generation > backend_generation:
    if client_server_epoch == current_server_epoch:
        → CLIENT_AHEAD_SUSPICIOUS (genuine forgery — log GENERATION_COUNTER_FORGERY)
    else if client_server_epoch < current_server_epoch:
        → DB_RESTORED (legitimate) — return CLIENT_BEHIND semantics, CP adopts Backend's (lower, post-restore) state
```
INV-18 (one reconciliation code path for all outage durations, seconds or weeks).

**Server-epoch-store unavailability fails closed** (Freeze Audit P1-7 — an earlier draft specified fail-closed behavior for KMS unavailability in Phase 3 but left the analogous case for the epoch store undefined): if `SERVER_EPOCH_STORE` is unreachable when a reconciliation call needs to compare `server_epoch`, `POST /reconciliation` returns `503 SERVICE_UNAVAILABLE` — reconciliation must never proceed with a stale-cached or assumed epoch value, since silently skipping the check would quietly defeat CRIT-05's protection during exactly the window (post-incident) it matters most. The current epoch value may be cached in-process with a short TTL (e.g. 30s) to avoid a store round-trip on every call, but the cache itself must fail closed on expiry if a refresh fails — it never serves a value past its TTL.

**Operator-forgets-to-advance-epoch degrades safely, not silently** (Freeze Audit P2-12): if a database is restored but the runbook step (§16) to increment `server_epoch` is skipped, Backend cannot detect this on its own — from its point of view this looks identical to "clean restart, no restore happened." Every CP reconnecting with a generation counter *ahead* of the restored DB's counter will then be correctly flagged as `CLIENT_AHEAD_SUSPICIOUS` per the algorithm below, even though the real cause is an unadvanced epoch rather than forgery. This is the intended, safe failure direction: a skipped runbook step produces **false-positive forgery alerts that an operator investigates and can correct**, not silent acceptance of stale or forged state.

**Corrected per-counter algorithm** (CRIT-05):
```
if client_generation > backend_generation:
    if client_server_epoch == current_server_epoch:
        → CLIENT_AHEAD_SUSPICIOUS (genuine forgery — log GENERATION_COUNTER_FORGERY)
    else if client_server_epoch < current_server_epoch:
        → DB_RESTORED (legitimate) — return CLIENT_BEHIND semantics, CP adopts Backend's (lower, post-restore) state
```
**Failure Handling**: reconciliation under load (many CPs at once after a Backend restart) → rate-limited; CP-side jitter is a Backend Contract Dependency (§23); unknown-outcome recovery for any operation without its own idempotency key is resolved here, from authoritative Backend state, never guessed (INV-11) — there is no separate pending-transaction ledger this phase depends on (§6.4/Freeze Audit P1-1).
**Tests**: idempotency test (call twice, same result, no duplicate side effects); "Restored snapshot attack" and "Cloned VM" adversarial tests; DB-restore-is-not-forgery test using `server_epoch` (the direct regression test for CRIT-05); **epoch-store-unavailable test** (Freeze Audit P1-7): reconciliation called while `SERVER_EPOCH_STORE` is unreachable returns `503`, never a result computed against a stale or assumed epoch.
**Completion Criteria**: a full database restore from backup, followed by CPs reconnecting with stale-relative-to-restored generation counters, results in `DB_RESTORED` reconciliation, **not** mass machine revocation, provided the runbook's epoch-increment step was followed; if it wasn't, the system fails safe into false-positive forgery alerts rather than silent acceptance.

### Phase 16 — Audit

**Objective**: Security event logging with a hash chain that cannot fork under concurrency (closes CRIT-07).
**Prerequisites**: Phase 2 (can run in parallel with Phases 5–15; every other phase depends on *this* one's `log()` interface existing, so implement the interface early even though this write-up sequences it here for narrative flow — see §19 for the real parallelism note).
**Components**: Audit & Observability.
**Files**: `src/domain/audit/service.ts`, `src/domain/audit/hash-chain.ts`, `src/domain/audit/redactor.ts`, `src/domain/audit/repository.ts`.
**Database Changes**: `security_events` (+ `prev_hash`, `event_hash` columns per EV-07/B-05; `event_type` CHECK expanded to the full 35+ type list in §7.2), `accounts.last_event_hash` (per CRIT-07 fix).
**Interfaces**: `log(event): void`, `verifyChain(accountId, sinceEventId?): ChainVerification`, `export(filters, pagination): SecurityEvent[]`.
**API Changes**: `GET /admin/audit/events` (implemented here, exposed via Phase 13's admin routes).
**Protocol Changes**: none.
**State Changes**: insert-only; **no** `UPDATE`/`DELETE` grants on `security_events` at the DB permission level (INV-20).
**Transactions**: **the CRIT-07 fix, exactly**:
```sql
BEGIN;
  SELECT last_event_hash FROM accounts WHERE account_id = $1 FOR UPDATE;
  -- compute new_hash = SHA-256(prev_hash || event_data)
  INSERT INTO security_events (..., prev_hash, event_hash) VALUES (..., $prev, $new);
  UPDATE accounts SET last_event_hash = $new WHERE account_id = $1;
COMMIT;
```
This serializes all event insertion **per account** via the row lock — the chain is per-account, and is now provably linear instead of forkable.
**External Services**: none.
**Security Requirements**: Never-Log List enforced centrally at the sink (redactor pattern-matches metadata JSONB before storage, not per call site) — password, private key, session secret, refresh credential, storage encryption key, machine private key; INV-16.
**Failure Handling**: corrupted chain detected on periodic verification → alert admin, continue logging (chain broken *at* the detected point, forensic integrity degraded from there but logging doesn't stop); events for account-less contexts (e.g. some machine-scoped anomaly before an account is known) chain against a machine-scoped or global genesis as a documented fallback (§21 DEC-13).

**Audit failure rolls back the business mutation it would have recorded — intentionally** (Freeze Audit P2-13): because the audit-event `INSERT` happens in the *same* transaction as the business mutation it records (the pseudocode above), a failure to insert the audit event — a bug in the redactor, or a `CHECK` constraint rejecting an `event_type` that hasn't been added to the enum yet — rolls back the **entire** business transaction, not just the audit write. This is deliberate: an unaudited security-relevant mutation is treated as worse than a failed operation. The direct consequence is that the `event_type` CHECK constraint (§5.4) must be extended defensively whenever a new event type is introduced — ideally in the same migration that introduces the code path emitting it — so that an otherwise-correct new feature doesn't fail in production solely because its audit event type wasn't yet in the enum.
**Tests**: concurrency test — N concurrent transactions logging events for the same account, assert the resulting chain is linear (the direct regression test for CRIT-07, previously guaranteed to fail without the `FOR UPDATE` lock); redaction unit test (password field never reaches storage); chain-tamper-detection test; **audit-failure-rolls-back-business-mutation test** (Freeze Audit P2-13): force an audit-insert failure (e.g. an `event_type` not in the CHECK list) and assert the associated business mutation (e.g. a session creation) is also rolled back, not partially applied.
**Completion Criteria**: hash chain cannot fork under any concurrency level (property-tested with concurrent writers); every domain module's calls into `log()` go through the redactor; a failed audit insert never leaves an unaudited business mutation committed.

### Phase 17 — Background Jobs

**Objective**: The six scheduled jobs this plan actually defines, plus the subscription-expiration scheduler that closes LP-04/EV-12. (An earlier draft's Definition of Done referred to "22 background/scheduled behaviors" — that number never corresponded to anything enumerated anywhere in this plan and has been corrected throughout, including in §24, to **six** — Freeze Audit P2-4.)
**Prerequisites**: Phases 8 (session cleanup), 4 (nonce purge), 14 (transfer cleanup), 16 (audit verification), 9/10 (license sync, subscription scheduler).
**Components**: cross-cutting; each job lives beside the module it serves but is registered centrally. Distinguish clearly: these six are **interval-triggered jobs**; the Outbox Worker (Phase 10) is a separate, continuously-running claim/lease consumer loop, not one of these six; ordinary HTTP request handlers are neither.
**Files**: `src/jobs/session-cleanup.ts`, `src/jobs/nonce-purge.ts`, `src/jobs/transfer-cleanup.ts`, `src/jobs/audit-verification.ts`, `src/jobs/license-sync.ts`, `src/jobs/subscription-scheduler.ts` (LP-04), `src/jobs/scheduler.ts` (registry + locking).
**Database Changes**: `scheduled_jobs` (lightweight table for distributed-lock/last-run bookkeeping).
**Interfaces**: `registerJob(name, intervalMs, handler, { lockKey })`.
**API Changes**: none (internal).
**Protocol Changes**: none.
**State Changes**: whatever each job's handler does (session expiry, nonce deletion, transfer expiry, license-sync drift correction, subscription period-end transition).
**Transactions**: each job run is its own transaction (or set of small transactions) — never one giant transaction across an unbounded row set; batched.
**External Services**: Keygen — the `license-sync` job is the **only** scheduled job that reads Keygen, per §9.1's authority model (read methods: `validateLicense`, `getMachineCount`, `getEntitlements`, `checkEntitlement`); any write this job needs to make to Backend's own `licenses` table as a result of detected drift goes through the same outbox path as every other license mutation, never a direct write from within the job.
**Security Requirements**: each job acquires an advisory/row lock (`lockKey`) so only one instance runs at a time in a multi-instance deployment.
**Failure Handling**: job failure is logged and retried on the next scheduled tick (not immediately retried in a tight loop); Keygen unreachable → `license-sync` skips its tick rather than failing hard (§9.1's fallback); missed subscription period-end transition is caught on the next run (idempotent — checks `current_period_end <= now()` rather than relying on precise timing).
**Tests**: each job unit-tested against a seeded DB state; subscription-scheduler test — subscription past `current_period_end` transitions to `EXPIRED` and cascades to license `EXPIRED` exactly once even if the job runs twice in the same window; `license-sync` drift test (a Keygen-side change not originated by Backend is detected and pulled into `licenses` with a `LICENSE_CHANGED`/`actor_type='PROVIDER'` audit event, per §9.1).
**Completion Criteria**: all **six** jobs running on schedule with distributed locking; `LP-04` closed (subscriptions now expire without a live webhook trigger); the Outbox Worker's continuous claim/lease loop (Phase 10) is not counted among these six and is verified separately.

### Phase 18 — API Integration

**Objective**: Wire every route from Phases 5–17 behind the actual HTTP server, with consistent middleware ordering.
**Prerequisites**: Phases 4–17.
**Components**: cross-cutting (`src/api/`).
**Files**: `src/api/server.ts`, `src/api/routes/*.ts` (already created per-phase, assembled here), `src/api/middleware/session-auth.ts`.
**Database Changes**: none.
**Interfaces**: middleware chain: `envelope-validator → session-auth (where applicable) → rate-limiter (auth routes) → route handler → error-handler`.
**API Changes**: none new — this phase is integration, not new endpoints.
**Protocol Changes**: none.
**State Changes**: none.
**Transactions**: none beyond what each route's service layer already does.
**External Services**: none.
**Security Requirements**: consistent application of Phase 6's signed-error and guard-field middleware across every route; admin routes (Phase 13) mounted on a **separate** router instance with its own middleware stack (INV-12 enforced at the routing layer, not just by convention).
**Failure Handling**: global error handler maps every thrown error to the Error Taxonomy (§10) — no unhandled exception reaches the client as a raw stack trace.
**Tests**: full route-inventory test (every endpoint in §7 responds and is wired to the correct middleware chain); admin-router-isolation test.
**Completion Criteria**: `npm run start` serves every endpoint in this plan behind one process.

### Phase 19 — Observability

**Objective**: Structured logging, metrics, health checks per Core Spec §33.3/§33.7/§33.8.
**Prerequisites**: Phase 18.
**Components**: cross-cutting.
**Files**: `src/observability/logger.ts`, `src/observability/metrics.ts`, `src/api/routes/health.ts`.
**Database Changes**: none.
**Interfaces**: structured JSON logger with level filtering; metrics exporter (Prometheus-shaped by default).
**API Changes**: `GET /health/live`, `GET /health/ready` (§16.3 — readiness checks DB, signing key, Keygen reachability).
**Protocol Changes**: none.
**State Changes**: none.
**Transactions**: none.
**External Services**: metrics/log aggregation backend (pluggable).
**Security Requirements**: same never-log enforcement as Phase 16, applied to application logs too (not just audit).
**Failure Handling**: n/a (observability itself must never throw and break a request).
**Tests**: readiness-check test (fails when DB or signing key unavailable); log-redaction test at the application-log sink.
**Completion Criteria**: all metrics from §33.8 exported; alerting conditions from §33.9 wired to the metrics that trigger them.

### Phase 20 — Integration Testing

**Objective**: Full end-to-end suite across all phases, including every adversarial/failure/concurrency scenario the two source documents specify.
**Prerequisites**: Phases 0–19.
**Components**: all.
**Files**: `test/integration/`, `test/security/`, `test/concurrency/`, `test/adversarial/`.
**Coverage** (full matrix in §18): the 4 end-to-end lifecycles — new user (signup→auth→register→authorize→use→renew→logout), payment (checkout→pay→license→capabilities→cancel→revoke-at-period-end), recovery (auth→crash-during-renewal→restart→reconcile→operational), upgrade (BASE→PRO→BASE with causal linkage maintained throughout); the full concurrency/race set in §8 (concurrent authentication, renewal vs. revocation, license update vs. authorization resolution, duplicate webhook, machine registration races, generation increments, revocation delivery ordering, parallel/out-of-order file-transfer chunks, completion vs. cancellation, logout vs. renewal, account suspension vs. active sessions); the adversarial test set in §18 (restored-snapshot attack, cloned VM, independently-evaluated authorization, offline-grace exploitation, revocation evasion, mass-revocation attack) plus the CRIT-05 DB-restore-is-not-forgery test and the CRIT-07 concurrent-hash-chain test; the three hostile-failure-scenario replays (payment webhook crash timeline — §6.2/§9's crash-point analysis, outbox worker killed mid-`PROCESSING` — Phase 10's crash-recovery regression test, revocation during offline grace — §8.4's documented consequence under DEC-12).
**Completion Criteria**: every test in §18 passes against a real (containerized) PostgreSQL instance, not mocks, for anything touching transactions/concurrency.

### Phase 21 — Deployment & Operational Readiness

**Objective**: Ship it.
**Prerequisites**: Phase 20.
**Components**: all.
**Covers**: build pipeline, secrets provisioning, migration execution order, TLS termination, signing-key provisioning in the target KMS, startup/shutdown sequence (Core Spec §33.1/§33.2 verbatim), backup/restore runbook (**including the new step**: increment `server_epoch` as part of every restore, per CRIT-05 — this is now a mandatory runbook line item, not optional), scheduled-job supervisor config.
**Completion Criteria**: see §15 (Deployment) and §24 (Definition of Done) in full.


## 5. Consolidated Database Schema (Corrected/Evolved)

This is the Core Spec §9 schema with every Hostile Audit correction (B-*, DB-*, EV-*) applied. This is the schema Phase 2 migrates.

### 5.1 Core Tables

Table creation order below is the **verified-executable** order (Freeze Audit P0-1/P0-7): `plan_entitlements` and `licenses` are created before `authorizations` so its `license_id` foreign key resolves against a table that already exists, and `pgcrypto` is enabled before anything calls `gen_random_uuid()`. This is not a cosmetic reordering — the original draft had `authorizations` before `licenses`, which fails migration outright; that ordering is retired, not retained alongside this one.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- required by every gen_random_uuid() default below (Freeze Audit P0-7)

CREATE TABLE accounts (
  account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  credentials_hash VARCHAR(512) NOT NULL,             -- Argon2id
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LOCKED','SUSPENDED','DELETED')),
  lockout_count INTEGER NOT NULL DEFAULT 0,
  lockout_expires_at TIMESTAMPTZ,                     -- renamed from lockout_until (B-04 clarity fix)
  last_event_hash VARCHAR(64) NOT NULL DEFAULT encode(sha256('GENESIS'::bytea), 'hex'),  -- CRIT-07 fix
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_accounts_email ON accounts(email);
CREATE INDEX idx_accounts_status ON accounts(status);

CREATE TABLE machines (
  machine_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  public_key_hex VARCHAR(64) NOT NULL,
  -- B-09 fix: CP-only pre-registration states removed
  status VARCHAR(30) NOT NULL DEFAULT 'REGISTERED'
    CHECK (status IN ('REGISTERED','VERIFIED','CORRUPTED','REPLACEMENT_REQUIRED','RE_VERIFICATION_REQUIRED','REVOKED')),
  machine_generation BIGINT NOT NULL DEFAULT 1,        -- DEC-06: counters start at 1
  descriptor JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_machines_account ON machines(account_id);
CREATE INDEX idx_machines_installation ON machines(installation_id);
CREATE UNIQUE INDEX idx_machines_pubkey ON machines(public_key_hex);
CREATE UNIQUE INDEX idx_machines_install_pubkey ON machines(installation_id, public_key_hex); -- idempotent registration

CREATE TABLE sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  machine_id UUID NOT NULL REFERENCES machines(machine_id) ON DELETE CASCADE,
  -- B-08/B-11 fix: CP-only pre-row states removed, PARTIAL added for deferred-authorization auth (§14.5)
  status VARCHAR(20) NOT NULL DEFAULT 'AUTHENTICATED'
    CHECK (status IN ('PARTIAL','AUTHENTICATED','EXPIRED','REVOKED','LOGGED_OUT')),
  session_generation BIGINT NOT NULL DEFAULT 1,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  renew_after TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_renewed_at TIMESTAMPTZ,
  server_key_version INTEGER NOT NULL DEFAULT 1,
  session_protocol_version INTEGER NOT NULL DEFAULT 2,  -- protocol v2 default
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_sessions_machine_active ON sessions(machine_id) WHERE status = 'AUTHENTICATED'; -- DEC-03: single active session/machine
CREATE INDEX idx_sessions_account ON sessions(account_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE plan_entitlements (             -- NEW: resolves DB-03 (no entitlements table)
  plan_id VARCHAR(50) PRIMARY KEY,           -- 'BASE' | 'PRO' | 'ENTERPRISE'
  capabilities JSONB NOT NULL,               -- union-set members (§3 item 8)
  limits JSONB NOT NULL,                     -- e.g. { "max_concurrent_browsers": 5 }
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE licenses (
  license_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  machine_binding UUID REFERENCES machines(machine_id),       -- EV-13 fix
  plan_id VARCHAR(50) NOT NULL REFERENCES plan_entitlements(plan_id),
  status VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN'
    CHECK (status IN ('UNKNOWN','VALID','EXPIRING','EXPIRED','REVOKED','SUSPENDED','INVALID')),
  capabilities JSONB NOT NULL,               -- materialized from plan_entitlements at issue time
  limits JSONB NOT NULL,
  license_revision BIGINT NOT NULL DEFAULT 1,   -- advances ONLY when the license itself changes (Freeze Audit P0-6) — never from authorization/resolve
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),            -- EV-13 fix
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,                                     -- EV-13 fix
  last_verified_at TIMESTAMPTZ,                                -- EV-13 fix
  keygen_license_id VARCHAR(255),                              -- EV-13 fix
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  -- NOTE: an earlier draft also carried a `backend_revision` column duplicating `license_revision` with no
  -- distinct meaning and no other reference anywhere in this plan. Removed (Freeze Audit P1-4) rather than
  -- retained unused — if a genuinely separate "administrative touch, not an entitlement change" counter is
  -- ever needed, it must be named and specified as its own decision, not silently reintroduced here.
);
CREATE INDEX idx_licenses_account ON licenses(account_id);
CREATE INDEX idx_licenses_status ON licenses(status);

CREATE TABLE authorizations (
  authorization_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  license_id UUID REFERENCES licenses(license_id),      -- EV-14/B-06 fix: enables targeted cascade; resolves cleanly now that `licenses` is created first (Freeze Audit P0-1)
  status VARCHAR(20) NOT NULL DEFAULT 'VALID' CHECK (status IN ('VALID','EXPIRED','REVOKED','SUPERSEDED')),
  capability_set JSONB NOT NULL,
  policy_version INTEGER NOT NULL DEFAULT 1,
  authorization_revision BIGINT NOT NULL DEFAULT 1,
  observed_license_revision BIGINT NOT NULL,   -- stamped from licenses.license_revision at resolve time; read-only copy, not a second source of truth
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_authorizations_session ON authorizations(session_id);
CREATE INDEX idx_authorizations_license ON authorizations(license_id);
CREATE INDEX idx_authorizations_status ON authorizations(status);
```

### 5.2 Generation State (Normalized — B-07/DB-04/EV-15)

```sql
-- Account-scoped: license_revision belongs to the account, not a specific machine
CREATE TABLE account_generation_states (
  account_id UUID PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  license_revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Machine-scoped: session/authorization/machine generation are per (account, machine)
CREATE TABLE machine_session_states (
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  machine_id UUID NOT NULL REFERENCES machines(machine_id) ON DELETE CASCADE,
  session_generation BIGINT NOT NULL DEFAULT 1,
  authorization_revision BIGINT NOT NULL DEFAULT 1,
  machine_generation BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, machine_id)
);

-- Global: server_trust_version tracks Backend signing-key epoch (in Postgres — fine, it's not
-- the restore-detection mechanism). server_epoch (CRIT-05) is intentionally NOT here — see §5.3.
CREATE TABLE backend_trust_state (
  singleton_guard BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton_guard),
  server_trust_version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO backend_trust_state (singleton_guard) VALUES (true);
```

Monotonicity is enforced with a trigger, not just application discipline (INV-03):

```sql
CREATE OR REPLACE FUNCTION reject_generation_decrease() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.session_generation < OLD.session_generation
     OR NEW.authorization_revision < OLD.authorization_revision
     OR NEW.machine_generation < OLD.machine_generation THEN
    RAISE EXCEPTION 'generation counter decrease rejected';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_machine_session_states_monotonic
  BEFORE UPDATE ON machine_session_states FOR EACH ROW EXECUTE FUNCTION reject_generation_decrease();

CREATE OR REPLACE FUNCTION reject_license_revision_decrease() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.license_revision < OLD.license_revision THEN
    RAISE EXCEPTION 'license_revision decrease rejected';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_account_generation_states_monotonic
  BEFORE UPDATE ON account_generation_states FOR EACH ROW EXECUTE FUNCTION reject_license_revision_decrease();

-- Freeze Audit P2-9: the same protection is extended to machines.machine_generation directly (previously
-- only machine_session_states.machine_generation — a mirrored copy — was trigger-protected).
CREATE OR REPLACE FUNCTION reject_machine_generation_decrease() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.machine_generation < OLD.machine_generation THEN
    RAISE EXCEPTION 'machine_generation decrease rejected';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_machines_monotonic
  BEFORE UPDATE ON machines FOR EACH ROW EXECUTE FUNCTION reject_machine_generation_decrease();
```

### 5.3 Server Epoch — Deliberately Outside Postgres (CRIT-05)

`server_epoch` **must not** live in a table that a database restore would itself roll back — that would defeat its entire purpose (a restore needs the epoch to *survive* the restore so post-restore reconciliation can tell "this is a restore" apart from "this is forgery"). It is stored in whatever the deployment's KMS/parameter-store adapter (Phase 3/DEC-09) provides — e.g. AWS SSM Parameter Store, HashiCorp Vault KV, or equivalent — read on every request that needs it, incremented only via a dedicated admin action that is part of the DB-restore runbook (§15). This is the one piece of Backend "state" this plan does **not** put in PostgreSQL, by design.

### 5.4 Security, Transactions, Payments, FTS, Admin, Keys

```sql
CREATE TABLE security_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(account_id) ON DELETE SET NULL,
  machine_id UUID REFERENCES machines(machine_id) ON DELETE SET NULL,
  session_id UUID REFERENCES sessions(session_id) ON DELETE SET NULL,
  event_type VARCHAR(50) NOT NULL CHECK (event_type IN (        -- DB-05 fix: full 35+ type list
    'LOGIN_SUCCESS','LOGIN_FAILURE','SESSION_RENEWED','SESSION_EXPIRED','SESSION_REVOKED',
    'LICENSE_CHANGED','LICENSE_REVOKED','LICENSE_CREATED','LICENSE_SUSPENDED','LICENSE_REACTIVATED',
    'MACHINE_IDENTITY_CHANGED','MACHINE_REGISTERED','MACHINE_REVOKED','MACHINE_CLONE_DETECTED',
    'KEY_ROTATED','SERVER_KEY_CHANGED','INTEGRITY_FAILURE','ROLLBACK_DETECTED','CLOCK_ANOMALY',
    'STORAGE_CORRUPTION','UNAUTHORIZED_IPC','AUTHORIZATION_GRANTED','AUTHORIZATION_REVOKED',
    'AUTHORIZATION_EXPIRED','PAYMENT_RECEIVED','PAYMENT_FAILED','PAYMENT_REFUNDED','ACCOUNT_LOCKED',
    'ACCOUNT_SUSPENDED','ACCOUNT_REINSTATED','ADMIN_ACTION','CIRCUIT_BREAKER_TRIGGERED',
    'CIRCUIT_BREAKER_OVERRIDDEN','RECONCILIATION_PERFORMED','GENERATION_COUNTER_FORGERY','REVOCATION_CASCADE'
  )),
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  actor_type VARCHAR(10) NOT NULL CHECK (actor_type IN ('SYSTEM','USER','ADMIN','PROVIDER')),
  actor_id VARCHAR(255),
  session_generation BIGINT, machine_generation BIGINT, authorization_revision BIGINT,
  transaction_id UUID,
  old_state VARCHAR(50), new_state VARCHAR(50),
  result VARCHAR(20) NOT NULL CHECK (result IN ('SUCCESS','FAILURE','DENIED','ERROR')),
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,     -- redacted before insert (Phase 16)
  prev_hash VARCHAR(64) NOT NULL,                  -- CRIT-07 fix
  event_hash VARCHAR(64) NOT NULL,                 -- CRIT-07 fix
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE UPDATE, DELETE ON security_events FROM PUBLIC;   -- INV-20
CREATE INDEX idx_security_events_account ON security_events(account_id);
CREATE INDEX idx_security_events_type ON security_events(event_type);
CREATE INDEX idx_security_events_created ON security_events(created_at);

-- NOTE (Freeze Audit P1-1): an earlier draft also defined a `pending_transactions` table
-- (CREATED → SENT → RESPONSE_PENDING → COMMITTED → RETRY_PENDING → FAILED) intended as a general
-- unknown-outcome ledger. It was never wired into any phase's workflow — nothing ever created,
-- transitioned, or cleaned up a row — so it could never hold data as specified. Rather than leave
-- unused infrastructure with no owner, it is removed: unknown-outcome recovery for every operation
-- in this plan is fully covered without it, by the per-operation idempotency registry (§6.3) plus
-- generation-mismatch-triggered reconciliation (§4 Phase 15) plus outbox idempotency keys (§6.2/§10).
-- If a future operation genuinely needs "let the CP ask what happened to a specific past request"
-- beyond what those three mechanisms already provide, that is new design work requiring its own
-- decision — not a table to silently resurrect.

CREATE TABLE server_nonces (
  nonce VARCHAR(128) PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  epoch BIGINT NOT NULL
);
CREATE INDEX idx_nonces_received ON server_nonces(received_at);  -- purge job target (60s TTL)

CREATE TABLE outbox_events (                        -- CRIT-03 fix, lease mechanism added per Freeze Audit P0-3
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(50) NOT NULL,                  -- 'CREATE_LICENSE' | 'REVOKE_LICENSE' | 'REVOCATION_NOTICE' | ...
  payload JSONB NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','DELIVERED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  claimed_at TIMESTAMPTZ,                           -- NEW: when a worker claimed this row
  lease_expires_at TIMESTAMPTZ,                     -- NEW: claim is void after this instant — enables reclaim
  worker_id VARCHAR(100),                           -- NEW: which worker instance holds the current claim
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_pending ON outbox_events(status, next_attempt_at) WHERE status IN ('PENDING','PROCESSING');
CREATE INDEX idx_outbox_stale_lease ON outbox_events(lease_expires_at) WHERE status = 'PROCESSING';

CREATE TABLE file_transfers (
  transfer_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  remote_session_id UUID NOT NULL UNIQUE,
  file_id VARCHAR(255) NOT NULL,
  total_size BIGINT NOT NULL,
  total_chunks INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  content_hash VARCHAR(128) NOT NULL,
  hash_algorithm VARCHAR(20) NOT NULL DEFAULT 'sha256',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  acked_chunks JSONB NOT NULL DEFAULT '[]'::jsonb,   -- EV-09 fix: [[start,end],...] ranges
  status VARCHAR(20) NOT NULL DEFAULT 'INITIALIZING'
    CHECK (status IN ('INITIALIZING','UPLOADING','COMPLETING','COMPLETED','CANCELLED','FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_file_transfers_session ON file_transfers(session_id);

CREATE TABLE file_transfer_chunks (
  transfer_id UUID NOT NULL REFERENCES file_transfers(transfer_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  chunk_offset BIGINT NOT NULL,
  chunk_size INTEGER NOT NULL,
  chunk_hash VARCHAR(128) NOT NULL,
  acked BOOLEAN NOT NULL DEFAULT false,
  acked_at TIMESTAMPTZ,
  PRIMARY KEY (transfer_id, chunk_index)
);

CREATE TABLE subscriptions (                          -- moved ahead of payment_events (Freeze Audit P2-2) so
                                                       -- payment_events.subscription_id can carry a real FK
  subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  provider_subscription_id VARCHAR(255) NOT NULL UNIQUE,
  plan_id VARCHAR(50) NOT NULL REFERENCES plan_entitlements(plan_id),
  status VARCHAR(20) NOT NULL CHECK (status IN ('ACTIVE','PAST_DUE','CANCELLED','EXPIRED')),
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id VARCHAR(255) NOT NULL UNIQUE,
  provider VARCHAR(50) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(subscription_id),   -- Freeze Audit P2-2: now a real FK
  amount DECIMAL(10,2), currency VARCHAR(3),
  status VARCHAR(20) NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','PROCESSING','PROCESSED','FAILED')),
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE scheduled_jobs (                        -- NEW: LP-04 fix support
  job_name VARCHAR(100) PRIMARY KEY,
  last_run_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ
);

CREATE TABLE admin_users (
  admin_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  credentials_hash VARCHAR(512) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('SUPER_ADMIN','LICENSE_ADMIN','SUPPORT','AUDIT')),
  mfa_secret VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES admin_users(admin_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE revocation_circuit_breaker (   -- R-03 fix (persisted, not in-memory); moved after admin_users
                                             -- so overridden_by resolves cleanly (Freeze Audit P0-2).
                                             -- Fixed one-minute window, not a sliding/rolling window
                                             -- (Freeze Audit P1-2 / DEC-16) — window_start identifies the
                                             -- window (date_trunc('minute', now())); a revocation clustered
                                             -- at a window boundary can, in the worst case, allow up to 2x
                                             -- CIRCUIT_BREAKER_THRESHOLD before tripping. Accepted tradeoff
                                             -- for implementation simplicity over a true sliding-window log.
  window_start TIMESTAMPTZ PRIMARY KEY,
  revocation_count INTEGER NOT NULL DEFAULT 0,
  tripped BOOLEAN NOT NULL DEFAULT false,
  overridden_by UUID REFERENCES admin_users(admin_id),
  overridden_reason TEXT
);

CREATE TABLE backend_keys (
  key_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_version INTEGER NOT NULL UNIQUE,
  public_key_hex VARCHAR(64) NOT NULL,
  -- private key material NEVER stored here; KMS/HSM only
  status VARCHAR(20) NOT NULL
    CHECK (status IN ('GENERATED','ACTIVE','ROTATION_PENDING','ROTATED','RETIRED','DESTROYED','KEY_COMPROMISED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ, retired_at TIMESTAMPTZ, destroyed_at TIMESTAMPTZ
);
```

**Canonical lock order** (applies to every multi-table transaction, prevents the deadlock the Hostile Audit's Distributed Systems Engineer flagged as MEDIUM):
`accounts → machines → sessions → licenses → authorizations → account_generation_states → machine_session_states → security_events`.

**Verified migration order** (the order tables are actually created in `001_initial_schema.sql`, matching the CREATE TABLE statements above — Freeze Audit P0-1/P0-2/P0-7): `pgcrypto extension → accounts → machines → sessions → plan_entitlements → licenses → authorizations → account_generation_states → machine_session_states → backend_trust_state → security_events → server_nonces → outbox_events → file_transfers → file_transfer_chunks → subscriptions → payment_events → scheduled_jobs → admin_users → admin_sessions → revocation_circuit_breaker → backend_keys`. Every inline `REFERENCES` clause in the schema above resolves against a table created earlier in this same list — verified by inspection, and the first thing Phase 2's migration test checks (§4 Phase 2, §18).


## 6. Transactional Architecture

For every workflow: what happens inside PostgreSQL, what happens outside, what happens on crash at each point, how it's retried, how it's deduplicated.

### 6.1 Operation → Transaction Table

| Operation | Reads | Writes | Isolation | Atomicity | Generation Updates | External Call |
|---|---|---|---|---|---|---|
| Authenticate | `accounts`, `machines` | `sessions`, `authorizations`, `machine_session_states`, `security_events` | SERIALIZABLE | serialized per-account (`SELECT accounts FOR UPDATE`) | init `session_generation` | none inline |
| Session Renewal | `sessions`, `machine_session_states` | same + `security_events` | SERIALIZABLE | generation checked under lock | `session_generation`+1 | none |
| Authorization Resolution | `sessions`, `licenses` (`FOR UPDATE`, read-only lock) | `authorizations` (incl. stamping `observed_license_revision`), `machine_session_states` | READ COMMITTED (license row locked to avoid a stale read, never to justify a write to it) | reads `license_revision`, does **not** advance it (Freeze Audit P0-6) | `authorization_revision`+1 **only** | none |
| License Change (via Outbox) | `accounts`, `licenses` | `licenses`, `authorizations`, `account_generation_states`, `machine_session_states`, `security_events` | SERIALIZABLE | co-advance, single txn — this is the **only** operation that advances `license_revision` | `license_revision`+1, `authorization_revision`+1 | Keygen (async, outbox) |
| Payment Checkout Initiation | `accounts` | none (no Backend state mutation) | READ COMMITTED | synchronous, idempotency-keyed provider call; does not touch `licenses`/`authorizations`/`subscriptions` (Freeze Audit P0-4) | none | Payment provider (synchronous, `Idempotency-Key` header) |
| Revocation (any scope) | scope-dependent | full cascade tables | SERIALIZABLE | atomic cascade (INV-21) | scope-dependent, all +1 | `REVOCATION_NOTICE` (async, outbox, best-effort delivery — §4 Phase 12) |
| Machine Registration | `accounts`, `machines` | `machines`, `machine_session_states`, `security_events` | READ COMMITTED | idempotent on (installation_id, pubkey) | `machine_generation`+1 | none |
| Reconciliation | `machine_session_states`, `sessions`, `authorizations`, `licenses` (`FOR UPDATE` where concurrently-mutable) | none unless genuinely diverged | READ COMMITTED | idempotent (INV-11); fails closed (`503`) if `server_epoch` store is unreachable (Freeze Audit P1-7) | align with authoritative | none |
| Payment Webhook (Step 1) | `payment_events` | `payment_events`, `outbox_events` | READ COMMITTED | fast, no external call | — | none (enqueue only) |
| Payment Webhook (Step 2, Outbox Worker) | `outbox_events` | `licenses`, `authorizations`, `account_generation_states`, `security_events`, `outbox_events` | SERIALIZABLE | idempotency-keyed | co-advance | Keygen (idempotency-keyed) |
| FTS Initialize | `sessions`, `authorizations` | `file_transfers` | READ COMMITTED | capability check (`CAP_FILE_UPLOAD`) | none | none |
| FTS Chunk Upload | `file_transfers`, `file_transfer_chunks` | `file_transfer_chunks`, `file_transfers.acked_chunks` | READ COMMITTED | idempotent UPSERT per chunk | none | none |
| FTS Complete | `file_transfers`, `file_transfer_chunks` | `file_transfers` | READ COMMITTED | hash verified over all chunks | none | none |
| Audit Log | `accounts.last_event_hash` (`FOR UPDATE`) | `security_events`, `accounts.last_event_hash` | READ COMMITTED (serialized per-account by the lock) | linear chain (CRIT-07 fix) | none | none |

### 6.2 Crash-Point Analysis (per the Hostile Audit's Failure & Recovery Model, Part XX)

| Operation | Crash Point | State After Crash | Recovery | Safe? |
|---|---|---|---|---|
| Payment webhook | after outbox write, before worker claims it | outbox event `PENDING` | worker picks it up on next poll | Yes |
| Payment webhook / outbox worker | after worker **claims** row (`PROCESSING`), before provider request | row `PROCESSING`, lease running | **Freeze Audit P0-3 fix**: `lease_expires_at` passes, stale-lease sweep (`WHERE status='PROCESSING' AND lease_expires_at < now()`) reclaims the row, increments `attempts`, returns it to `PENDING` (or `FAILED` if `attempts >= max_attempts` — poison-event terminal state) | Yes, only with the lease fix — **without it, this row is stuck forever** |
| Payment webhook | after Keygen call succeeds, before delivery mark | Keygen has license, outbox still `PROCESSING`/lease may expire | worker retries with the same idempotency key; Keygen returns its cached result rather than double-creating | Yes |
| Payment checkout initiation | after provider call, before HTTP response reaches caller | Provider has a checkout session; Backend recorded nothing (by design — no state mutation, see §6.1) | Caller retries `/payments/checkout` with the same client-supplied idempotency key; provider returns the same checkout session rather than creating a second one | Yes |
| Session renewal | after commit, before response | `session_generation = N+1` in DB | CP retries with N, gets `GENERATION_MISMATCH`, reconciles | Yes (heavier, not unsafe) |
| Revocation | after commit, before notice delivery | session `REVOKED` in DB, outbox event `PENDING` | outbox worker delivers best-effort (§4 Phase 12); even with zero delivery, the CP's next request is independently rejected per INV-10 | Yes — delivery is an optimization, not the safety mechanism |
| Auth / re-authentication | after session create, before response | new session `AUTHENTICATED`, prior session (if any) `REVOKED` in the same transaction | CP retries; the revoke-then-replace transaction (§4 Phase 7) runs again, is safe to repeat | Yes |
| DB restore | all state rolled back | generations stale relative to CPs | Server Epoch increment (§5.3) + forced reconciliation, **not** classified as forgery, provided the epoch store itself is reachable (fails closed per Freeze Audit P1-7 if not) | Yes |
| FTS chunk | after chunk stored, before ack returned | chunk row exists, CP doesn't know | CP re-uploads; idempotent UPSERT on `(transfer_id, chunk_index)` | Yes |
| Audit log | crash between `SELECT … FOR UPDATE` and `INSERT` | no event row exists yet, lock released on rollback | caller (a domain transaction) re-executes as a whole — audit log is written in the same transaction as the domain change it records, so a failed audit insert rolls back the business mutation too (intentional fail-together — §4 Phase 16) | Yes |

### 6.3 Idempotency Registry

| Operation | Idempotency Key | Duplicate Behavior | Persisted In |
|---|---|---|---|
| Machine registration | `(installation_id, public_key_hex)` | return existing `machine_id` | `machines` unique index |
| Session renewal | `(session_id, session_generation)` | if generation already advanced, return current state | `machine_session_states` |
| Payment webhook | `provider_event_id` | skip, return 200 | `payment_events` unique |
| Outbox delivery | `idempotency_key` (= `provider_event_id` or synthesized) | Keygen/provider returns cached result | `outbox_events` unique + provider's own idempotency header |
| Transfer initialize | `transfer_id` (CP-generated) | return existing `remote_session_id` | `file_transfers` unique |
| Chunk upload | `(transfer_id, chunk_index)` | re-ack, no-op | `file_transfer_chunks` PK, UPSERT |
| Transfer complete | `remote_session_id` | return cached result if `COMPLETED` | status check |
| Reconciliation | `(account_id, machine_id)` | always returns authoritative state (inherently idempotent) | — |
| Logout | `session_id` | return success if already `LOGGED_OUT` | status check |
| Revocation | `(scope, target_id)` | return success if already `REVOKED` | status check |
| Payment checkout initiation | client-supplied or account-derived `Idempotency-Key`, forwarded to the provider | provider returns the cached checkout session rather than creating a duplicate | provider-side (Backend forwards the key, does not itself need to store anything since it mutates no Backend state — §6.1) |

**Idempotent-in-effect rather than idempotent-by-key**: Authentication/re-authentication is not idempotent in the sense of "returns the same `session_id`" (a fresh `session_id` is issued every time), but is **safe to retry** — the revoke-then-replace transaction (§4 Phase 7, Freeze Audit P1-6) always leaves exactly one `AUTHENTICATED` session for the machine no matter how many times it's retried, so a retried `AUTH_INIT` after a lost response converges to the same end state (one valid session) even though the specific `session_id` differs each time. Authorization Resolve is likewise not idempotent by key (the capability set legitimately varies call to call as license/session state changes) but is always **safe** to call repeatedly, since it only reads `licenses`/`sessions` and writes `authorizations`/`authorization_revision` — never `license_revision` (Freeze Audit P0-6). License Creation is idempotent via `(account_id, plan_id, idempotency_key)`.

### 6.4 Unknown Outcome After Crash

- Uncommitted transaction → no state change → client retries → reprocessed fresh.
- Committed transaction, response lost → client retries → idempotency key returns cached result, or (Authentication) the safe-to-retry revoke-then-replace sequence converges regardless.
- No explicit idempotency key for the operation → Reconciliation (Phase 15) resolves it from authoritative Backend state; never guessed (INV-11). This is the only unknown-outcome mechanism this plan uses — there is no separate general-purpose pending-transaction ledger (Freeze Audit P1-1: an earlier draft's `pending_transactions` table was removed as dead, unwired infrastructure; every operation's unknown-outcome path is covered by the idempotency registry above, outbox idempotency keys, and this reconciliation path).

---

## 7. Cryptographic Architecture

### 7.1 Algorithm Inventory

| Purpose | Algorithm | Parameters | Notes |
|---|---|---|---|
| Backend response signing | Ed25519 | domain prefix `b"CONTROL_PLANE_V1"` (16 bytes ASCII) | standard Ed25519 (RFC 8032) — NOT Ed25519ph, NOT Ed25519ctx |
| CP request verification | Ed25519 | same domain prefix | same library |
| Session payload confidentiality | AES-256-GCM | 12-byte random nonce, 16-byte tag | transport already has TLS 1.3; this is defense-in-depth for the envelope payload, keyed via the Phase 9-adjacent ECDHE exchange (EV-11) |
| Session key agreement | ECDHE (X25519) | per-session ephemeral keypair | **NEW — EV-11/S-02 fix**: closes the "session credential = long-lived machine key" forward-secrecy gap. The long-lived Ed25519 machine key continues to *authenticate* (sign) the ECDHE public key exchange; it no longer doubles as the encryption key. |
| Password hashing | Argon2id | memory ≥ 64 MiB, iterations ≥ 3, parallelism ≥ 1 | OWASP-recommended minimums |
| Key derivation | HKDF-SHA256 | salt=contextual, info=purpose string | used to derive the AES-256-GCM key from the ECDHE shared secret |
| Webhook verification | provider-specific | per payment provider | provider SDK |

### 7.2 Domain Separation Contract (the single most critical interop requirement)

```
DOMAIN_PREFIX = b"CONTROL_PLANE_V1"  // exactly 16 bytes, must byte-match the CP's Rust NativeCore

sign(privateKey, message):
    fullMessage = concat(DOMAIN_PREFIX, message)
    return ed25519_sign(privateKey, fullMessage)

verify(publicKey, message, signature):
    fullMessage = concat(DOMAIN_PREFIX, message)
    return ed25519_verify(publicKey, fullMessage, signature)
```

Backend signing pseudocode (canonical form, protocol v2):

```
function signEnvelope(envelope, keyVersion):
    canonical = JSON.stringify({
        version: envelope.version, msgId: envelope.msgId, generation: envelope.generation,
        timestamp: envelope.timestamp, epoch: envelope.epoch, server_epoch: envelope.server_epoch,
        payload: envelope.payload
    })                                          // EXPLICIT key order — see §8.2
    bytes = utf8Encode(canonical)
    signature = ed25519Sign(getPrivateKey(keyVersion), concat(utf8Encode("CONTROL_PLANE_V1"), bytes))
    return hexEncode(signature)                 // lowercase hex, 128 chars
```

If the Backend's canonical JSON differs from the CP's `envelope.mjs` output in **any** byte — field order, whitespace, number formatting — every signature verification fails silently. This is why Phase 4's contract test uses a fixture generated by running the actual CP code, not a hand-written approximation.

**Canonical encoder contract** (Freeze Audit P1-10/P1-11 — "use canonical JSON" is necessary but not sufficient; every byte-level choice below is part of the signed contract, not an implementation detail left to whoever writes the encoder):

| Concern | Rule |
|---|---|
| Field order | Exactly `version, msgId, generation, timestamp, epoch, server_epoch, payload` (v2) — no more, no fewer, never reordered |
| Whitespace | None — `JSON.stringify` with no indentation/spacing arguments; the canonical form is the most compact valid JSON encoding |
| String encoding | UTF-8 throughout; no other encoding is ever used for any field |
| Escaping | Standard JSON string escaping only (`"`, `\`, control characters) — no custom escaping scheme |
| Null vs. omitted fields | Every field in the field-order list above is always present, even when logically empty — a field that "doesn't apply" is serialized as explicit `null`, never omitted, so the object's shape never varies between messages |
| Integers | Serialized as ordinary JSON numbers, **except** `generation` and `server_epoch`, which are serialized as **decimal strings** (e.g. `"generation": "18446744073709551615"`, not a bare `18446744073709551615`) — this is the wire-format rule CP-11 requires to avoid float64 precision loss against Postgres `BIGINT`, and it is part of the *encoder*, not a CP-side parsing footnote: the bytes that get signed already contain the string form. Every other reference to `generation`/`server_epoch` elsewhere in this plan (§6.1's table, the schema's `BIGINT` columns) describes the **stored/decoded** representation; this section is the sole authority for the **wire** representation. |
| Arrays / nested objects (inside `payload`) | Canonicalized recursively by the same rules (compact, UTF-8, no key reordering *within* whatever object shape the specific message type defines) before the whole `payload` is itself serialized as an opaque Base64 string per the next row |
| `payload` encoding | Standard Base64 (RFC 4648 §4, with padding), applied to the UTF-8 bytes of the payload's own canonical JSON |
| Signature representation | Lowercase hexadecimal, 128 characters (64 bytes), one entry per key version in the `signatures` map |

**Domain separation is independent of protocol version** (Freeze Audit P2-6/§18): `CONTROL_PLANE_V1` (the Ed25519 domain-separation label) and `version: 2` (the envelope's field-layout version) are deliberately different, unrelated version axes. The domain label changes only if the signing scheme itself changes — a different signature algorithm, or a change to what bytes get signed — which has not happened between protocol v1 and v2; only the envelope's field layout changed (added `timestamp`, `server_epoch`, multi-key `signatures`). Protocol v2 correctly continues to sign under domain label `V1` for exactly this reason. Do not "fix" this to say `V2` — doing so would be changing a cryptographic domain separator to satisfy a cosmetic naming expectation, which is exactly the kind of change that should require its own deliberate security review, not a drive-by rename.

### 7.3 Key Inventory & Lifecycle

| Key | Storage | Rotation | Criticality |
|---|---|---|---|
| Backend Ed25519 signing key | KMS/HSM — never in code, DB, or logs | versioned via `server_trust_version`; dual-signing (v2 `signatures` map) during transition | CRITICAL |
| Backend Ed25519 public key | pinned in CP binary | coordinated with CP release | CRITICAL |
| TLS certificate | standard PKI | standard rotation | HIGH |
| Machine public keys | `machines.public_key_hex` | machine re-registration | HIGH |
| Database encryption key (at-rest) | KMS or encrypted config | periodic | HIGH |
| Keygen API key | secrets manager | as needed | MEDIUM |
| Payment provider key | secrets manager | as needed | MEDIUM |

Lifecycle: `GENERATED → ACTIVE → ROTATION_PENDING → ROTATED → RETIRED → DESTROYED`, with `KEY_COMPROMISED` reachable from any active state (emergency path: immediately mark compromised, force session invalidation for all sessions signed under that key version, alert).

### 7.4 Key Rotation Protocol (now actually implementable — CRIT-01 fix)

1. Generate keypair version N+1 in KMS. Status `GENERATED`.
2. Activate. Status `ACTIVE`; old key → `ROTATION_PENDING`.
3. Begin dual-signing: every response's `signatures` map includes **both** `{N: sig_old, N+1: sig_new}`.
4. Ship CP update with new pinned pubkey (Backend Contract Dependency, §23).
5. Monitor connecting CP versions; when all have updated, retire the old key.
6. Old key: `ROTATION_PENDING → ROTATED → RETIRED` (kept for verifying old signed data still in flight).
7. Eventually `RETIRED → DESTROYED`.
8. Increment `backend_trust_state.server_trust_version`.
9. **Bounded rotation window** (Hostile Audit "Key rotation window" finding, MEDIUM): if the *old* key is suspected compromised mid-rotation, do not wait for full CP adoption — set a maximum rotation window; on expiry without full adoption, force-revoke all sessions still verified under the old key rather than leaving them valid indefinitely.

---

## 8. Protocol v2 Specification

### 8.1 Transport

HTTPS / TLS 1.3 minimum. Backend URL path convention: `/v1/control-plane/...` for CP-facing envelope routes (version in the path is the **API** version, independent of the **protocol** version carried inside the envelope — see §16).

### 8.2 Envelope (v2)

```typescript
interface ProtocolEnvelopeV2 {
  version: 2;
  msgId: string;                        // UUID v4, replay-protection nonce
  generation: number;                   // relevant generation counter (uint64 as string — see note)
  timestamp: number;                    // ms since Unix epoch — CRIT-06 fix
  epoch: number;                        // nonce-set epoch
  server_epoch: number;                 // CRIT-05 fix — DB-restore detection
  payload: string;                      // Base64
  signatures: Record<string, string>;   // CRIT-01 fix — key_version (string) → hex signature (128 chars)
}
```

> **Note on `generation`/counters as wire values**: CP-11 (Hostile Audit) flags that the CP stores generation counters as JS `number` (float64), which loses precision above 2^53 against Postgres `BIGINT`. This is out of Backend's control to fix in the CP, but the Backend **does** control its own serialization: emit generation counters as **decimal strings**, not JSON numbers, in every response, so a CP that's fixed to use `BigInt` (Backend Contract Dependency, §23) can parse losslessly, and a CP that hasn't been fixed yet fails obviously (a string where it expected a number) rather than silently losing precision.

Canonical serialization — **explicit, mandatory key order**:

```
JSON.stringify({
  version, msgId, generation, timestamp, epoch, server_epoch, payload
})
```

v1 compatibility (accepted until `MIN_PROTOCOL_VERSION` is raised to 2): `{version: 1, msgId, generation, epoch, payload, signature}` (single signature, no `timestamp`/`server_epoch`) — validated on a legacy path that skips the timestamp/server-epoch checks and only allows a single active key version.

### 8.2.1 Replay Decision Procedure (Freeze Audit P1-9 — the single authoritative check order)

The individual pieces (`msgId` uniqueness, the `timestamp` window, generation/epoch checks) are each specified elsewhere in this plan; this is the one place that fixes the **order** they're applied in, since order changes behavior (e.g. burning a nonce slot on a request that's about to be rejected anyway for an unrelated reason). Every envelope-carrying request goes through exactly this sequence, implemented in Phase 4's `validateEnvelope`:

```
1. Parse envelope. Malformed → 400.
2. version < MIN_PROTOCOL_VERSION → 426 PROTOCOL_INCOMPATIBLE. (Stop — do not consume a nonce slot for a
   request that's being rejected for version reasons.)
3. |now() - timestamp| > REPLAY_GUARD_WINDOW_MS → 403 NONCE_EXPIRED (retryable: caller must obtain a fresh
   timestamp and a fresh msgId — an expired-timestamp request's msgId is never inserted into server_nonces,
   so retrying with a new timestamp but the SAME msgId is fine, though callers are expected to generate a
   new msgId anyway).
4. INSERT INTO server_nonces(nonce, received_at, epoch) VALUES (msgId, now(), epoch).
   Scope: GLOBAL, not per-session or per-account — msgId is a UUIDv4; the probability of two different,
   legitimate requests (even under different sessions) colliding on the same UUID is cryptographically
   negligible and is accepted as a non-issue, not specially handled.
   On unique violation → 403 NONCE_REPLAYED (not retryable — caller must generate a new msgId; this is the
   only outcome that is never retried with the same msgId).
5. Verify signature(s) in the envelope's `signatures` map against the claimed key version(s) — accept if
   ANY listed version's signature verifies (supports dual-signing during rotation, §7.4). Fail → 403
   SIGNATURE_INVALID.
6. Check the relevant generation counter (Phase 4's `checkGenerationCounter`) and `server_epoch` (Phase 15's
   CRIT-05 algorithm) against stored state. Stale/forged → route to the appropriate outcome (GENERATION_MISMATCH,
   GENERATION_FORGERY, or DB_RESTORED per §10's error taxonomy).
7. Dispatch to the route handler.
```

A duplicate `msgId` reused deliberately under a *different* session (freeze-audit replay test case "same msgId under different sessions") is rejected at step 4 exactly like any other replay — the global scope means Backend does not attempt to distinguish "malicious replay" from "coincidental reuse under a different session," since a UUIDv4 has no legitimate reason to repeat at all, from any source. A replay attempted *after* the underlying account/machine/session has been revoked is rejected the same way at step 4 (nonce-level) before it would even reach step 6's revocation checks — replay protection and revocation are independent, layered controls, not a single check.

### 8.3 Protocol Messages

| Message | Direction | Purpose |
|---|---|---|
| `AUTH_INIT` | CP→Backend | initiate authentication |
| `AUTH_RESULT` | Backend→CP | result + session + authorization + `GraceToken` |
| `MACHINE_REGISTER` / `MACHINE_REGISTER_RESULT` | CP→Backend / Backend→CP | machine registration |
| `SESSION_RENEW` / `SESSION_RENEW_RESULT` | CP→Backend / Backend→CP | renewal + updated `GraceToken` |
| `LICENSE_REQUEST` / `LICENSE_RESULT` | CP→Backend / Backend→CP | license status query |
| `AUTHORIZATION_REQUEST` / `AUTHORIZATION_RESULT` | CP→Backend / Backend→CP | authorization resolution |
| `SECURITY_STATE_REQUEST` / `SECURITY_STATE_RESULT` | CP→Backend / Backend→CP | reconciliation |
| `REVOCATION_NOTICE` | Backend→CP | pushed or piggybacked revocation |

### 8.4 GraceToken (CRIT-04 fix, offline-budget model finalized per Freeze Audit P1-5)

```typescript
interface GraceToken {
  account_id: string;
  machine_id: string;
  capabilities: string[];
  not_before: number;             // ms epoch
  not_after: number;              // ms epoch — absolute capability expiry, the ONLY validity bound
  signature: string;              // Ed25519(Backend key, canonical(above fields))
}
```

An earlier draft also carried `max_offline_budget_ms` as a second, independently-consumed budget alongside `not_after`. It is removed: this plan never operationalized a consumption model for it (total-vs-per-capability, continuous-vs-per-operation, reset-on-reconnect — none of these were ever specified), and `not_after` alone already provides everything the offline-grace mechanism needs — a single, absolute, signed deadline. If a genuinely separate "cumulative offline minutes before mandatory re-check-in, regardless of which capability" budget is wanted in the future, it requires its own explicit state machine (an offline-period-start timestamp and a cumulative-consumed counter, reset only on a fresh signed check-in) — that would be new design work, not something this plan silently reintroduces.

Issued in `AUTH_RESULT` and `SESSION_RENEW_RESULT`. Capability-specific TTLs (EV-20): capabilities that gate *starting new execution* (e.g. `CAP_AUTOMATION_START`-class) get short `not_after` (hours); read-only/informational capabilities get long or no expiry; license/entitlement-changing operations are never grace-covered (always require live Backend contact) — matches Core Spec §22.3's offline capability policy table exactly, now backed by a signature instead of trust-the-client.

**Documented consequences of the offline-grace design** (Freeze Audit §11, folded in here rather than left implicit):
- **Clock rollback/freeze on the CP** is a Backend Contract Dependency (§23 item 2) — the CP is responsible for maintaining `highest_observed_time` and refusing to honor a token if its own clock appears to have moved backwards; Backend cannot enforce this for a CP it isn't currently talking to.
- **Restoring an old local CP database** to "regain" an expired token has no effect — `not_after` is an absolute, externally-signed deadline, not a locally-tracked counter that a restored snapshot could roll back.
- **Two cloned installations sharing a valid token**: a `GraceToken` is scoped to a specific `(account_id, machine_id)` pair but carries no additional single-use marker of its own. If clone detection (Phase 5) fails to catch a cloned installation before a token is issued, both the original and the clone could use the same token until `not_after`. This is a real but low-probability residual risk — clone detection is the actual first line of defense here, not the token — and is accepted as part of DEC-12's bounded-exposure tradeoff, not a separate open item.
- **Machine revocation or account suspension during an active grace period**: an already-issued `GraceToken` remains cryptographically valid until its own `not_after` even if the underlying machine/account is revoked while the CP is offline — there is no mechanism to invalidate it early, by definition of "offline" (Backend has no channel to the CP to tell it anything). Short `not_after` values for capability-starting operations (§9.3) are the only lever that bounds this exposure; this is an explicit consequence of DEC-12, not an oversight.
- **A token's `not_after` passing mid-operation**: Backend has no visibility into operations executing on the CP (that's inherently CP-local) and does not track "in-flight operations" against a token. Whether to gracefully complete or abort an in-flight operation when its governing token expires mid-execution is a CP-side decision — documented as Backend Contract Dependency §23 item 2 — not something Backend specifies or can specify.

### 8.5 API Contract Summary

| Endpoint | Auth | Idempotent | Notes |
|---|---|---|---|
| `POST /auth/init` | none | no | rate-limited 5/account/15min, 20/IP/15min |
| `POST /machines/register` | session | yes (`installation_id`+pubkey) | requires authenticated session (S-01 fix) |
| `POST /sessions/renew` | session + machine sig | idempotent per generation | includes `responseValidated: true` |
| `POST /sessions/logout` | session + machine sig | yes | |
| `POST /authorization/resolve` | session + machine sig | recomputed each call (not cached) | includes `backendConfirmed: true` |
| `POST /licenses/validate` | session + machine sig | yes | |
| `POST /reconciliation` | session + machine sig | yes (by design) | must be idempotent |
| `POST /transfers/initialize` | session token + `CAP_FILE_UPLOAD` | yes (`transfer_id`) | non-envelope |
| `POST /transfers/:id/chunks` | session token + capability re-checked | yes (per chunk) | non-envelope |
| `POST /transfers/:id/complete` \| `/cancel` | session token | yes | non-envelope |
| `GET /transfers/:id/status` | session token | n/a | returns `acked_chunks` ranges |
| `POST /payments/checkout` | account | no | non-envelope |
| `POST /payments/webhook` | provider signature | yes (`provider_event_id`) | non-envelope |
| `GET/POST /admin/*` | admin session + MFA | operation-dependent | never envelope (INV-12) |

`POST /payments/checkout`'s row above is intentionally listed as "no" under Idempotent-by-key in the general sense but is safe to retry via a forwarded provider `Idempotency-Key` (§9.2) — see §6.1's "Payment Checkout Initiation" row and §6.3 for the corrected, explicit semantics (Freeze Audit P0-4): this is a synchronous, state-mutation-free provider call, not a violation of the "no synchronous entitlement-mutating provider calls" rule that governs the rest of the payment domain.


## 9. External Provider Integrations

### 9.1 Keygen CE (Licensing) — Authority Model (Freeze Audit P0-5, resolved unambiguously)

**Backend's own `licenses` table is authoritative for every authorization decision.** `authorization/resolve` (Phase 11) never calls Keygen inline, under any circumstance, at any latency budget — this is the one invariant that must never be relaxed. Beyond that single hard rule, Keygen is both written to and read from, in clearly separated ways:

```text
authorization/resolve
        ↓
  Backend DB only
        ↓
  NO LIVE KEYGEN CALL, ever
```

- **Write methods** (`createLicense`, `revokeLicense`, `suspendLicense`, `reactivateLicense`, `activateMachine`, `deactivateMachine`, `changePlan`) are called **only by the Outbox Worker**, asynchronously, whenever Backend's own state changes (signup, in-app upgrade/downgrade, webhook-driven change, Backend-initiated revocation).
- **Read methods** (`validateLicense`, `getMachineCount`, `getEntitlements`, `checkEntitlement`) are called **only** by the `license-sync` background job (Phase 17, on a schedule, for drift detection) and by explicitly authorized Admin reconciliation (Phase 13) — **never** by the request-time `authorization/resolve` path, and never by Authentication.

**Reconciliation direction, stated explicitly** (this is what "Backend DB and Keygen disagree — who wins?" resolves to): Backend's DB always wins for anything Backend itself last wrote — Backend is the write-of-record for entitlement changes originating in Backend (signups, in-app upgrades, webhook-driven changes, Backend-initiated revocations). Keygen wins only for state changed directly in Keygen's own dashboard/API by an operator acting outside Backend's control (e.g. a manual support action taken directly in Keygen) — the `license-sync` job detects such drift by comparing Backend's `licenses` row against Keygen's current state, and when it finds Keygen has a change Backend didn't originate, it logs a `LICENSE_CHANGED` audit event with `actor_type = 'PROVIDER'` and pulls that change into Backend's `licenses` table (never the reverse for this specific case — a Keygen-originated change is pulled in, but a Backend-originated change is never overwritten by a stale Keygen read).

```typescript
interface LicensingProvider {
  // Write methods — Outbox Worker only
  createLicense(accountId, planId, machineBinding?): Promise<LicenseGrant>;
  revokeLicense(licenseId, reason): Promise<void>;
  suspendLicense(licenseId): Promise<void>;
  reactivateLicense(licenseId): Promise<void>;
  activateMachine(licenseId, machineFingerprint): Promise<MachineActivation>;
  deactivateMachine(licenseId, machineFingerprint): Promise<void>;
  changePlan(licenseId, newPlanId): Promise<PlanChangeResult>;
  // Read methods — license-sync job and Admin reconciliation ONLY, never the request-time authorization path
  validateLicense(licenseId, machineId): Promise<LicenseValidation>;
  getMachineCount(licenseId): Promise<{current: number, max: number}>;
  getEntitlements(licenseId): Promise<Entitlement[]>;
  checkEntitlement(licenseId, featureCode): Promise<boolean>;
}
```

An architecture test enforces the calling-convention split above: static analysis of the compiled module graph asserts that none of the four read methods are ever imported or called from `src/domain/authorization/` or `src/domain/auth/` — only from `src/jobs/license-sync.ts` and `src/admin/`.

| Adapter Method | Keygen CE API |
|---|---|
| `createLicense` | `POST /licenses` |
| `validateLicense` | `POST /licenses/:id/actions/validate` |
| `revokeLicense` | `DELETE /licenses/:id` or `PATCH {status:'SUSPENDED'}` |
| `activateMachine` | `POST /machines` |
| `deactivateMachine` | `DELETE /machines/:id` |
| `getEntitlements` | `GET /licenses/:id/entitlements` |
| `changePlan` | `PATCH /licenses/:id` |

Every write method accepts and forwards an `Idempotency-Key` header (Keygen supports this) sourced from the outbox event's `idempotency_key` — this is what makes the CRIT-03 fix's "retry after crash" path safe.

| Keygen Error | Adapter Behavior |
|---|---|
| `404` | `LicenseNotFound` — caller decides create-vs-error |
| `422` | `InvalidOperation` — log, surface specific error |
| `429` | retry with backoff |
| `5xx` | retry with backoff, circuit-break after N consecutive failures |
| timeout | retry, then fail — Backend continues serving from its own `licenses` table |

**Fallback**: if Keygen is down, Backend's `licenses` table is the authoritative record and continues serving every authorization decision unaffected; Keygen is a synchronization target for Backend-originated changes and a drift-detection source for Keygen-originated changes, never a read-path dependency for authorization decisions. Backend never exposes Keygen internals to CP or Frontend (INV-14, architecture-tested).

### 9.2 Payment Provider

`PaymentProvider` port (implemented by `adapters/payment/adapter.ts`):

```typescript
interface PaymentProvider {
  createCheckoutSession(params): Promise<CheckoutSession>;
  createSubscription(customerId, planId): Promise<Subscription>;
  cancelSubscription(subscriptionId, atPeriodEnd): Promise<void>;
  changeSubscriptionPlan(subscriptionId, newPlanId): Promise<Subscription>;
  verifyWebhookSignature(payload, signature): boolean;
  createCustomer(params): Promise<Customer>;
  getCustomer(customerId): Promise<Customer>;
}
```

Webhook processing (every event, in order):
1. Verify signature — reject if invalid (INV-19).
2. Extract `provider_event_id` → check `payment_events` for duplicate → skip if present.
3. Route by event type: `payment_succeeded` → enqueue license create/activate; `payment_failed` → enqueue suspend (after grace); `subscription_cancelled` → enqueue expiry-at-period-end; `subscription_updated` → enqueue plan update; `refund`/`chargeback` → enqueue revoke.
4. All license-affecting outcomes go through the causal-linkage-preserving outbox flow (§6.1), never a synchronous mutation from the webhook handler itself.
5. Log to audit trail.

| Scenario | Behavior |
|---|---|
| Payment succeeds, license creation fails | outbox retries with idempotency key; after max attempts, alert admin, event stays `PROCESSING` |
| Payment fails after provisional license | license stays `SUSPENDED` until confirmed or timed out |
| Refund/chargeback | license → `REVOKED`, cascade via Revocation Service (Phase 12) |
| Subscription cancellation | license → `EXPIRING`; capability set unchanged until period end (via the scheduler, Phase 17), then `EXPIRED` |
| Plan upgrade mid-cycle | immediate update, prorated by provider |
| Plan downgrade mid-cycle | scheduled for period end |
| Duplicate webhook | deduplicated on `provider_event_id` |

**LP-03 (chargeback exploitation via offline grace)**: a chargeback revokes the license/authorization immediately in the DB, but a network-partitioned CP won't see the `REVOCATION_NOTICE` until it reconnects — bounded by the `GraceToken`'s `not_after` for whatever capabilities it was last issued (§8.4), not by the full 7-day offline-grace budget. This is the same residual risk noted in Phase 12 and tracked as DEC-12.

### 9.3 GraceToken TTL-by-Tier (supporting table for Phase 9/EV-20)

| Capability Class | Offline Continuation | New Grant While Offline | `not_after` Guidance |
|---|---|---|---|
| Continue active execution (already holds an ExecutionAuthorization) | Yes, within budget | n/a | hours, risk-tier-dependent |
| Start new execution (`CAP_AUTOMATION_START`-class) | n/a | **Denied** — cached auth never sufficient for a new grant | not applicable (never offline-grantable) |
| Read-only/informational | Yes, indefinitely | Yes | long / no expiry |
| License/entitlement-changing | n/a | **Denied** — always requires live Backend | not applicable |

---

## 10. Error Taxonomy

Every error defines: code, HTTP status, category, retryable, requires re-auth, requires reconciliation, security event, safe client message.

| Code | HTTP | Category | Retryable | Reauth | Reconcile | Security Event |
|---|---|---|---|---|---|---|
| `AUTH_FAILED` | 401 | Auth | No | Yes | No | `LOGIN_FAILURE` |
| `AUTH_ACCOUNT_LOCKED` | 423 | Auth | No | No | No | `LOGIN_FAILURE` |
| `AUTH_ACCOUNT_SUSPENDED` | 403 | Auth | No | No | No | `LOGIN_FAILURE` |
| `AUTH_RATE_LIMITED` | 429 | Auth | Yes (Retry-After) | No | No | — |
| `SESSION_EXPIRED` | 401 | Session | No | Yes | No | `SESSION_EXPIRED` |
| `SESSION_REVOKED` | 401 | Session | No | Yes | No | `SESSION_REVOKED` |
| `SESSION_INVALID` | 401 | Session | No | Yes | No | — |
| `MACHINE_NOT_FOUND` | 404 | Machine | No | No | No | — |
| `MACHINE_REVOKED` | 403 | Machine | No | No | Yes | `MACHINE_IDENTITY_CHANGED` |
| `MACHINE_SIGNATURE_INVALID` | 403 | Machine | No | No | No | `INTEGRITY_FAILURE` |
| `MACHINE_CLONE_SUSPECTED` | 403 | Machine | No | No | Yes | `MACHINE_IDENTITY_CHANGED` |
| `GENERATION_MISMATCH` | 409 | Protocol | No | No | Yes | `ROLLBACK_DETECTED` |
| `GENERATION_FORGERY` | 403 | Protocol | No | No | No | `GENERATION_COUNTER_FORGERY` |
| `DB_RESTORED` | 409 | Protocol | No | No | Yes | `RECONCILIATION_PERFORMED` — **new outcome, CRIT-05 fix** |
| `NONCE_REPLAYED` | 403 | Protocol | No | No | No | — |
| `NONCE_EXPIRED` | 403 | Protocol | Yes (new nonce) | No | No | — |
| `PROTOCOL_INCOMPATIBLE` | 426 | Protocol | No | No | No | — |
| `SIGNATURE_INVALID` | 403 | Crypto | No | No | No | `INTEGRITY_FAILURE` |
| `CAPABILITY_DENIED` | 403 | Authorization | No | No | No | — |
| `LICENSE_EXPIRED` \| `LICENSE_REVOKED` \| `LICENSE_SUSPENDED` | 403 | Licensing | No | No | No | `LICENSE_REVOKED`/`LICENSE_CHANGED` |
| `PAYMENT_WEBHOOK_INVALID` | 400 | Payment | No | No | No | — |
| `PAYMENT_WEBHOOK_DUPLICATE` | 200 | Payment | n/a | No | No | — |
| `TRANSFER_NOT_FOUND` \| `TRANSFER_CANCELLED` \| `TRANSFER_COMPLETED` | 404/409 | FTS | No | No | No | — |
| `TRANSFER_HASH_MISMATCH` | 422 | FTS | No | No | No | — |
| `CHUNK_HASH_MISMATCH` | 422 | FTS | Yes (resend) | No | No | — |
| `INTERNAL_ERROR` | 500 | Internal | Yes (backoff) | No | No | — |
| `SERVICE_UNAVAILABLE` | 503 | Internal | Yes (Retry-After) | No | No | — |
| `DATABASE_ERROR` | 500 | Internal | Yes (backoff) | No | No | `STORAGE_CORRUPTION` |
| `ADMIN_AUTH_REQUIRED` | 401 | Admin | No | Yes (admin) | No | — |
| `ADMIN_PERMISSION_DENIED` | 403 | Admin | No | No | No | — |
| `CIRCUIT_BREAKER_ACTIVE` | 503 | Admin | No | No | No | — |

Response format (Protocol Envelope routes wrap this in a **signed** envelope — Phase 6/Hostile-Audit signed-error fix; non-envelope routes return it bare):

```json
{ "error": { "code": "SESSION_EXPIRED", "message": "Session expired", "retryable": false,
              "requires_reauthentication": true, "requires_reconciliation": false } }
```

---

## 11. Audit — Cross-Reference

Full spec implemented in Phase 16. Event schema, hash-chain algorithm (CRIT-07-fixed), never-log list, retention (security events ≥ 1 year, auth events ≥ 2 years), and admin read access are all specified there; not repeated here.

## 12. Administration — Cross-Reference

Full spec implemented in Phase 13. Roles (`SUPER_ADMIN`/`LICENSE_ADMIN`/`SUPPORT`/`AUDIT`), dangerous-operation safeguards, MFA requirement, and the separate `/admin/*` auth path are all specified there.

## 13. Background Jobs — Cross-Reference

Full spec implemented in Phase 17. Six jobs (session cleanup, nonce purge, transfer cleanup, audit chain verification, license sync, subscription scheduler) with distributed locking via `scheduled_jobs`.


## 14. Configuration Registry

| Name | Type | Default | Range | Security | Runtime Mutable | Restart | Admin Config | Audit |
|---|---|---|---|---|---|---|---|---|
| `SESSION_LIFETIME_MS` | uint64 | 3600000 | 300000–86400000 | Medium | Yes | No | Yes | Yes |
| `SESSION_RENEWAL_THRESHOLD_MS` | uint64 | 300000 | 60000–`SESSION_LIFETIME_MS`/2 | Medium | Yes | No | Yes | Yes |
| `OFFLINE_GRACE_MAX_MS` | uint64 | 604800000 | 3600000–2592000000 | High | Yes | No | Yes | Yes |
| `AUTH_MAX_ATTEMPTS_PER_ACCOUNT` | uint32 | 5 | 1–100 | High | Yes | No | Yes | Yes |
| `AUTH_LOCKOUT_BASE_MS` | uint64 | 60000 | 10000–86400000 | Medium | Yes | No | Yes | Yes |
| `AUTH_RATE_LIMIT_PER_IP` | uint32 | 20 | 5–1000/15min | Medium | Yes | No | Yes | No |
| `REPLAY_GUARD_WINDOW_MS` | uint64 | 30000 | 5000–120000 | High | No | Yes | No | Yes |
| `NONCE_PURGE_INTERVAL_MS` | uint64 | 60000 | 30000–300000 | Low | Yes | No | No | No |
| `CIRCUIT_BREAKER_THRESHOLD` | uint32 | 10 | 1–1000/min | High | Yes | No | Yes | Yes |
| `ADMIN_SESSION_LIFETIME_MS` | uint64 | 1800000 | 300000–7200000 | High | Yes | No | Yes | Yes |
| `TRANSFER_TIMEOUT_MS` | uint64 | 86400000 | 3600000–604800000 | Low | Yes | No | Yes | No |
| `TRANSFER_MAX_FILE_SIZE` | uint64 | 5368709120 | 1048576–107374182400 | Low | Yes | No | Yes | No |
| `TRANSFER_CHUNK_SIZE` | uint32 | 8388608 | 65536–67108864 | Low | Yes | No | Yes | No |
| `TRANSFER_MAX_CONCURRENT` | uint32 | 3 | 1–10 | Low | Yes | No | Yes | No |
| `ARGON2_MEMORY_COST` | uint32 | 65536 | 65536–1048576 KiB | High | No | Yes | No | Yes |
| `ARGON2_TIME_COST` | uint32 | 3 | 3–10 | High | No | Yes | No | Yes |
| `ARGON2_PARALLELISM` | uint32 | 1 | 1–4 | Medium | No | Yes | No | No |
| `MIN_PROTOCOL_VERSION` | uint32 | 2 | 1– | Critical | No | Yes | No | Yes |
| `BACKEND_BASE_URL` | string | (env-specific) | — | Medium | No | Yes | No | No |
| `DATABASE_URL` | string | — | — | Critical | No | Yes | No | No |
| `KEYGEN_API_URL` / `KEYGEN_API_KEY` | string | — | — | Medium/Critical | No | Yes | No | No |
| `PAYMENT_WEBHOOK_SECRET` | string | — | — | Critical | No | Yes | No | No |
| `AUDIT_RETENTION_DAYS` | uint32 | 365 | 90–3650 | Medium | Yes | No | Yes | No |
| `CLEANUP_JOB_INTERVAL_MS` | uint64 | 3600000 | 600000–86400000 | Low | Yes | No | No | No |
| `SERVER_EPOCH_STORE` | string | (env-specific) | — | Critical | No | Yes | No | No |
| `GRACE_TOKEN_DEFAULT_TTL_MS` | uint64 | 7200000 | 300000–604800000 | High | Yes | No | Yes | Yes |

> Critical/High values load only from env vars or the secrets manager, never repo config files; never appear in logs; runtime changes are audit-logged (Phase 1/Phase 16).

## 15. Observability — Cross-Reference

Full spec implemented in Phase 19: structured JSON logs (DEBUG/INFO/WARN/ERROR/FATAL, never-log enforced), metrics (auth attempts/successes/failures/lockouts; session counts; license counts by tier; p50/p95/p99 latency; DB pool usage; FTS transfer counts/bytes; circuit-breaker status), health checks (`/health/live`, `/health/ready`), and the alerting table below.

| Condition | Severity | Action |
|---|---|---|
| Signing key unavailable | CRITICAL | page on-call |
| Database connection failure | CRITICAL | page on-call |
| Circuit breaker triggered | HIGH | alert admin |
| Auth failure spike (>5x baseline) | HIGH | alert security |
| Generation counter forgery detected | CRITICAL | alert security |
| Audit chain corruption detected | HIGH | alert security |
| Keygen adapter unavailable >5min | MEDIUM | alert ops |
| Payment webhook signature failure | HIGH | alert security |
| Outbox queue depth over threshold | HIGH | alert ops (worker-starvation guard, Phase 10) |

## 16. Deployment & Operations

**Startup sequence**: load config (Phase 1) → validate secrets → init DB pool → run migrations (Phase 2) → verify audit chain integrity, last N events (Phase 16) → load active signing key from KMS (Phase 3) → init Keygen adapter connection (Phase 9) → init payment webhook listener (Phase 10) → start HTTP server (Phase 18) → mark READY.

**Shutdown sequence**: stop accepting connections → wait for in-flight requests (30s timeout) → close DB connections → flush audit log buffer → exit.

**Migrations**: versioned, idempotent, run at startup before traffic; destructive migrations require `--allow-destructive`; history tracked in a `migrations` table.

**Backups & restoration**: automated daily DB backups with point-in-time recovery; audit log backed up separately (compliance); signing keys handled by KMS/HSM backup. **Mandatory runbook addition (CRIT-05)**: every restore **must** increment `server_epoch` (§5.3) as part of the restore procedure, before traffic resumes — this is what makes the post-restore reconciliation path (`DB_RESTORED`, not `GENERATION_COUNTER_FORGERY`) work.

**Scheduled jobs**: see §13/Phase 17.

## 17. Versioning and Compatibility

| Component | Current | Format | Owner |
|---|---|---|---|
| Protocol Version | 2 (v1 accepted during migration) | uint32 | shared (Backend + CP) |
| Backend API Version | v1 | semver prefix in URL path | Backend |
| Database Schema Version | — | sequential integer | Backend |
| Policy Version | 1 | uint32 | Backend |
| Server Trust Version | 1 | uint64, monotonic | Backend |

| Scenario | Backend Behavior |
|---|---|
| CP `protocol_version < MIN_PROTOCOL_VERSION` | `426 PROTOCOL_INCOMPATIBLE` |
| CP `protocol_version == current` | process normally |
| CP `protocol_version > Backend's current` | process if backward-compatible fields only; must-ignore semantics for unknown fields (P-05 fix) |
| `server_trust_version` changed | CP detects on next contact, `SERVER_KEY_CHANGED` |
| `policy_version` changed | CP updates local policy cache |

**Upgrade sequence**: Backend deploys first with dual v1/v2 support → CP update ships with v2 support → once all CPs updated, raise `MIN_PROTOCOL_VERSION` to 2 and drop v1 → `server_trust_version` advances if signing keys changed during the window.

**Downgrade prevention**: Backend enforces its `MIN_PROTOCOL_VERSION` floor; a CP presenting below it is rejected outright — prevents forcing a downgrade to a weaker (v1, single-signature, no-timestamp) protocol.


## 18. Testing Strategy

| Category | Coverage |
|---|---|
| **Migration** | fresh, genuinely empty PostgreSQL database migrates successfully on the first attempt (no manual reordering); every table, FK, index, and the `pgcrypto` extension exist afterward; re-running the migration is a no-op — this is Phase 2's own completion criterion and the direct regression test for the original schema's forward-reference bugs (Freeze Audit P0-1/P0-2/P0-7) |
| **Outbox / Background Worker** | worker claim via `SELECT … FOR UPDATE SKIP LOCKED`; worker killed mid-`PROCESSING` → lease expires → stale-lease sweep reclaims the row → retried successfully by a fresh worker instance, license created/updated exactly once (Freeze Audit P0-3 regression test); poison event reaches terminal `FAILED` at `max_attempts`, never retried forever; each of the six scheduled jobs unit-tested against a seeded DB state with its distributed lock |
| **Unit** | Ed25519 sign/verify + domain-separation golden vectors; canonical JSON byte-for-byte match against the full encoder contract (§7.2 — field order, UTF-8, escaping, null-not-omitted, decimal-string generation/epoch encoding); Argon2id hash/verify; generation counter validation (<, ==, >); replay guard per the explicit decision procedure (§8.2.1: parse → version → timestamp → nonce → signature → generation, in that order); causal-linkage co-advance (License Change only) and violation-detection; fixed-window circuit-breaker threshold and boundary-burst behavior; audit hash-chain append/verify; redactor field-stripping |
| **Integration** | full auth flow including the revoke-then-replace re-authentication sequence (§4 Phase 7); session renewal; license upgrade (payment webhook → capability change, via the outbox); revocation cascade; file transfer (init→chunks→complete) with authoritative/derived ack-state consistency; reconciliation; machine registration |
| **Authorization / License-Revision Regression** (Freeze Audit P0-6) | calling `authorization/resolve` repeatedly against an unchanged license leaves `licenses.license_revision` bit-for-bit unchanged across all calls, while `machine_session_states.authorization_revision` advances on every call; `licenses.license_revision` changes if and only if a License Change transaction (Phase 9/10) actually ran |
| **Authentication / Concurrency** (Freeze Audit P1-6) | two simultaneous `AUTH_INIT` calls for the same machine → exactly one `AUTHENTICATED` session exists afterward, the other is `REVOKED`, and neither call surfaces a uniqueness-constraint error to its caller; re-authentication after a lost response converges to the same one-session end state |
| **Keygen Authority** (Freeze Audit P0-5) | architecture test: `authorization/resolve` and `authentication` never import or call any `LicensingProvider` read method; `license-sync` and Admin are the only callers of read methods; a Keygen-side change not originated by Backend is detected by `license-sync` and pulled into `licenses` with a `LICENSE_CHANGED`/`actor_type='PROVIDER'` audit event; a Backend-originated change is never overwritten by a stale Keygen read |
| **Payment** (Freeze Audit P0-4) | checkout-session creation is synchronous and idempotency-keyed (retried checkout with the same `Idempotency-Key` returns the same provider session); checkout initiation never writes `licenses`/`authorizations`/`subscriptions` (architecture + integration test); provider timeout on checkout is safely retryable; the full "payment webhook crash timeline" (verify → enqueue → commit+200 → async worker claims → provider call → DB follow-up) does not duplicate a license under any injected crash point; duplicate webhook delivery is a no-op (`provider_event_id` unique); outbox events for one account are processed in enqueue order even under concurrent worker pickup |
| **Contract (CP↔Backend interop)** | Backend-signed envelope verifiable by a CP-shaped verifier; domain separation byte-exact; canonical JSON field order exact per §7.2's full encoder contract; generation counters and `server_epoch` serialize as decimal strings, losslessly; guard fields (`nonceValidated`, `responseValidated`, `backendConfirmed`, `nonceChecked`) present in the exact response types that need them; FTS response shapes return `acked_chunks` ranges |
| **Database/Concurrency** | concurrent renewal (exactly one succeeds per generation); revocation-during-renewal race; revocation-during-authorization-resolution race (the `licenses` row lock resolves this without granting on a stale read, and without incorrectly writing `license_revision` — P0-6); deadlock resistance under the canonical lock order; optimistic-concurrency on generation counters; cascade atomicity; multi-instance circuit-breaker test (two Backend instances incrementing the same window's counter concurrently, trip fires at the correct combined count) |
| **Security** | forged signature rejected; missing domain prefix rejected; replayed/expired nonce rejected per the §8.2.1 decision procedure; generation forgery/rollback detected; session hijack across machines rejected (signature mismatch); privilege escalation via CP path to admin rejected (INV-12, enforced at the routing layer); webhook forgery rejected; SQL injection prevented (parameterized queries); password-comparison timing; rate-limit enforcement |
| **Property/State-Machine** | generation monotonicity under randomized operation sequences, now including `machines.machine_generation` directly (not just its mirrored copy in `machine_session_states`); session terminal states have no outgoing transitions; authorization never `VALID` without `AUTHENTICATED` session, and never mutates `license_revision`; causal linkage co-advances only on License Change; fixed-window circuit breaker trips at threshold under randomized batches, including at window boundaries |
| **Failure/Recovery** | DB crash mid-transaction → clean rollback; Backend crash mid-response → safe retry (idempotency key, or safe-to-retry re-authentication); Keygen unreachable → Backend continues serving every authorization decision from its own `licenses` table unaffected, `license-sync` skips its tick; signing key unavailable → `503`, never an unsigned response; `server_epoch` store unavailable → `503` on reconciliation, never a stale-epoch result (Freeze Audit P1-7); clock skew tolerance in nonce validation |
| **Adversarial** | restored-snapshot attack → `GENERATION_MISMATCH`/reconciliation, **not** immediate revocation unless `server_epoch` also matches (CRIT-05 regression test), and a *skipped* epoch-increment runbook step degrades to false-positive forgery alerts rather than silent acceptance (Freeze Audit P2-12); cloned VM (same `installation_id`, different pubkey) → `CLONE_SUSPECTED`; independently-evaluated authorization (CP claims ignored); offline-grace exploitation → `GraceToken` `not_after` enforced, not local CP trust, and no separate offline-budget counter to manipulate (P1-5); revocation evasion → any subsequent request from a `REVOKED` session is rejected regardless of what the CP itself believes or whether it ever received a `REVOCATION_NOTICE` (P1-12); mass-revocation attack → fixed-window circuit breaker halts, persists across a restart |
| **File Transfer** | parallel/out-of-order chunk acknowledgment produces correct `acked_chunks` ranges, always consistent with what `file_transfer_chunks.acked` independently computes (Freeze Audit P1-3); chunk-hash mismatch retried; cancellation racing an in-flight chunk upload → chunk write loses if cancellation commits first, no partial state either way (P2-5); confused-deputy chunk upload (mismatched session/remoteSessionId) rejected; resume from an interrupted transfer |
| **Audit** | concurrent audit-event writes for one account never fork the hash chain (direct CRIT-07 regression test); a failed audit insert (e.g. an unrecognized `event_type`) rolls back the associated business mutation rather than leaving it partially applied (Freeze Audit P2-13); redaction verified at the sink, not per call site |
| **End-to-End** | new-user lifecycle (signup→auth→register→authorize→use→renew→logout); payment lifecycle (checkout→pay→license→capabilities→cancel→revoke-at-period-end); recovery lifecycle (auth→crash-during-renewal→restart→reconcile→operational); upgrade lifecycle (BASE→PRO→BASE with causal linkage maintained throughout, and `license_revision` changing only on the actual upgrade/downgrade steps, never on the authorization checks in between) |

## 19. Implementation Order / Dependency Graph

```text
Tier 0 (parallel): Phase 0 (repo) 
Tier 1 (parallel, after Tier 0): Phase 1 (config), Phase 2 (DB), Phase 3 (crypto)
Tier 2 (after Tier 1): Phase 4 (protocol/envelope)
Tier 3 (parallel, after Tier 2): Phase 5 (machine identity), Phase 6 (gateway hardening), Phase 16 (audit — interface needed early, see note)
Tier 4 (after Tier 3): Phase 7 (authentication)
Tier 5 (after Tier 4): Phase 8 (session management)
Tier 6 (after Tier 5): Phase 9 (licensing + GraceToken)
Tier 7 (after Tier 6): Phase 10 (outbox + payment), Phase 11 (authorization) — can run in parallel with each other
Tier 8 (parallel, after Tier 7): Phase 12 (revocation), Phase 14 (FTS), Phase 15 (reconciliation)
Tier 9 (after Tier 8): Phase 13 (admin — calls into everything above)
Tier 10 (after Tier 9): Phase 17 (background jobs)
Tier 11 (after Tier 10): Phase 18 (API integration)
Tier 12 (after Tier 11): Phase 19 (observability)
Tier 13 (after Tier 12): Phase 20 (integration testing)
Tier 14 (after Tier 13): Phase 21 (deployment)
```

Each phase's own template follows `Phase → Prerequisites → Implementation → Migration → Tests → Integration → Acceptance` per the requested format; the tiering above is the cross-phase dependency graph.

**Note on Audit (Phase 16)**: its **interface** (`log()`) is a dependency of nearly every other phase (Auth, Session, Machine, Licensing, Payment, Revocation, Admin all call it), so `log()`'s signature should be finalized and stubbed by end of Tier 3 even though the full hash-chain implementation (with the CRIT-07 fix) doesn't need to be complete until whatever calls `verifyChain()`/`export()` (Phase 13's admin audit endpoint) is built. Don't let this create a false dependency cycle: `log()` is a leaf call from every module's perspective (Audit itself depends on nothing but Persistence).

---

## 20. Target Repository Layout

No existing Backend repository was supplied alongside these specifications — this is a greenfield build. What follows is the target structure (not a file-level diff), directly reflecting the module map in §1 and the schema in §5.

```text
backend/
├── src/
│   ├── main.ts
│   ├── config/{index.ts, schema.ts}
│   ├── crypto/{ed25519.ts, aead.ts, hashing.ts, keys.ts, kms-adapter.ts, index.ts}
│   ├── protocol/{envelope.ts, canonical.ts, replay-guard.ts, generation.ts, v1-compat.ts, index.ts}
│   ├── app/                          # NEW — Application Service Layer (EV-16/MB-01 fix)
│   │   ├── authenticate.ts
│   │   ├── reconcile.ts
│   │   └── ...
│   ├── domain/
│   │   ├── auth/{service.ts, repository.ts, types.ts}
│   │   ├── machine/{service.ts, repository.ts, clone-detector.ts, types.ts}
│   │   ├── session/{service.ts, repository.ts, types.ts}
│   │   ├── authorization/{service.ts, capability-registry.ts, repository.ts, types.ts}
│   │   ├── licensing/{service.ts, provider.ts, repository.ts, grace-token.ts, types.ts}
│   │   ├── payment/{service.ts, provider.ts, webhook-handler.ts, repository.ts, types.ts}
│   │   ├── revocation/{service.ts, circuit-breaker.ts, types.ts}
│   │   ├── reconciliation/{service.ts, types.ts}
│   │   └── audit/{service.ts, hash-chain.ts, redactor.ts, repository.ts, types.ts}
│   ├── outbox/{worker.ts, repository.ts}      # NEW — CRIT-03 fix
│   ├── adapters/
│   │   ├── keygen/adapter.ts
│   │   ├── payment/adapter.ts
│   │   └── storage/adapter.ts
│   ├── admin/{auth.ts, routes.ts, rbac.ts, types.ts}
│   ├── transfer/{service.ts, repository.ts, types.ts}
│   ├── persistence/{connection.ts, migrations/, transaction.ts}
│   ├── api/
│   │   ├── routes/{auth.ts, machines.ts, sessions.ts, authorization.ts, licenses.ts,
│   │   │            reconciliation.ts, transfers.ts, payments.ts, admin.ts, health.ts}
│   │   ├── middleware/{envelope-validator.ts, rate-limiter.ts, session-auth.ts, error-handler.ts}
│   │   └── server.ts
│   ├── jobs/{session-cleanup.ts, nonce-purge.ts, transfer-cleanup.ts, audit-verification.ts,
│   │         license-sync.ts, subscription-scheduler.ts, scheduler.ts}
│   ├── observability/{logger.ts, metrics.ts}
│   └── errors/{codes.ts, types.ts}
├── test/{unit/, integration/, contract/, security/, concurrency/, adversarial/, e2e/}
├── migrations/001_initial_schema.sql
└── package.json
```

| Module | Depends On | Must Not Depend On | Owns |
|---|---|---|---|
| Crypto | KMS adapter (leaf) | any domain module | signing key lifecycle |
| Protocol | Crypto | Licensing, Payment, Admin | nonce store |
| AppService | all domain modules | — | — (orchestration only) |
| Auth | AppService, Session, Machine, Licensing (reads Backend's own `licenses` table only — never Keygen), Crypto, Audit | Payment, Admin, FTS, adapters | `accounts` |
| Machine | Crypto, Audit | Session, Authorization, Licensing, Payment, Admin | `machines` |
| Session | Machine, Persistence, Audit | Licensing, Payment, FTS | `sessions` |
| Authorization | Session, Machine, Licensing (reads Backend's own `licenses` table only — never Keygen, never any `LicensingProvider` read method, enforced by architecture test per §9.1/Freeze Audit P0-5), Audit | Payment, Keygen (directly or via the port's read methods), FTS | `authorizations` |
| Licensing | `LicensingProvider` port — **write** methods called only via the Outbox Worker; **read** methods called only by the `license-sync` background job and Admin — never by Authentication or Authorization (§9.1) | Payment (directly), Session, Auth, Machine, Keygen (directly, i.e. bypassing the port) | `licenses` |
| Payment | `PaymentProvider` port, Licensing, Outbox, Audit | Session, Auth, Machine, Authorization | `subscriptions`, `payment_events` |
| Revocation | Session, Authorization, Machine, Licensing, Outbox, Audit | Payment (directly), Authentication | circuit-breaker state |
| FTS | Session, Authorization, Storage adapter | Licensing, Payment, Machine, Authentication | `file_transfers`, chunks |
| Audit | Persistence | every domain module | `security_events` |
| Outbox Worker | Persistence, Keygen adapter (write methods), Payment adapter | any synchronous request path | `outbox_events` |
| Admin | all domain modules (as caller), including `LicensingProvider` read methods for manual reconciliation | Protocol Envelope, CP communication | `admin_users`, `admin_sessions` |

---

## 21. Design Decision Register

Every decision applied throughout §3–§20, with the alternatives considered.

| ID | Question | Options Considered | Decision Applied | Impact | Status |
|---|---|---|---|---|---|
| DEC-01 | Canonical JSON: object or array? | (A) object matching CP code, (B) array matching baseline doc | **A** | Critical — wrong choice fails all signatures | Resolved |
| DEC-02 | Authoritative capability set | (A) CP's 4, (B) canonical's 7, (C) union | **C**, tier mapping configuration-driven | High | Resolved |
| DEC-03 | Concurrent session policy | (A) single/machine, (B) multiple, (C) N-max | **A** | Medium | Resolved |
| DEC-04 | Revocation delivery | (A) piggyback, (B) WebSocket, (C) SSE, (D) long-poll | **A + B hybrid** | High | Resolved |
| DEC-05 | File storage backend | (A) local FS, (B) S3/GCS, (C) configurable adapter | **C**, default local FS in dev | Low | Resolved |
| DEC-06 | Initial generation counter value | (A) 0, (B) 1 | **B** | Low — verify against actual CP behavior before final lock | Resolved (verify) |
| DEC-07 | Implementation language | (A) TS/Node, (B) Go, (C) Rust, (D) other | **A** | Medium | Resolved |
| DEC-08 | Database | (A) PostgreSQL, (B) other SQL | **A** | Low | Resolved |
| DEC-09 | Signing key storage | (A) AWS KMS, (B) Azure Key Vault, (C) Vault, (D) local encrypted file | **pluggable adapter, default (A)** | High | Resolved (confirm target env) |
| DEC-10 | Plan/tier definitions | — | BASE/PRO/ENTERPRISE per §17.3-equivalent tier table, capabilities from union set | Medium | Resolved |
| DEC-11 | Envelope payload encryption beyond TLS | (A) TLS only, (B) additional AEAD | **A** for MVP | Medium | Resolved |
| DEC-12 | Residual offline-revocation window | Accept bounded exposure via `GraceToken` `not_after` vs. requiring permanent connectivity (infeasible for a distributed desktop product) | **Accept, bounded by capability-specific TTL** | High — security/availability tradeoff, should be explicitly sign-off'd by Security team, not silently inherited | **OPEN — intentional product/security decision, not a normalization issue; needs explicit sign-off on the exact TTL values in §9.3 before Phase 21** |
| DEC-13 | Audit hash-chain genesis for account-less (pre-authentication or machine-only) events | (A) machine-scoped genesis, (B) global genesis, (C) defer logging until an account is known | **B** (global genesis chain for account-less events), reduces special-casing | Low | Resolved (confirm) |
| DEC-14 | `server_epoch` storage technology | AWS SSM Parameter Store / HashiCorp Vault KV / other config store outside the Postgres backup boundary | **environment-dependent — pick one per DEC-09's KMS choice**, must not be included in DB backups | Critical (this is what makes CRIT-05's fix actually work) | **OPEN — intentional deployment-target decision, not a normalization issue; pick concrete technology per deployment target before Phase 21** |
| DEC-15 | Keygen authority model — is Keygen ever read, and by whom? | (A) never read ("write-only"), (B) read anywhere, (C) read only by background sync + admin reconciliation, never on the request-time authorization path | **C** — Backend DB is authoritative for authorization decisions (never a live Keygen call there); Keygen read methods exist and are used, but only by `license-sync` (Phase 17) and Admin (Phase 13); reconciliation direction: Backend wins for Backend-originated changes, Keygen wins for Keygen-originated (out-of-band) changes | Critical — this was a P0 self-contradiction (Freeze Audit P0-5) between "write-only" framing and the port's own read methods | Resolved |
| DEC-16 | Circuit breaker algorithm: fixed window or true rolling/sliding window? | (A) fixed one-minute window (matches the original schema shape), (B) true sliding-window log (more precise, more complex) | **A** — kept the simpler, already-specified schema; corrected the prose (which had said "rolling") to match it rather than building a sliding-window log to match the prose. Accepted consequence: a burst clustered at a window boundary can allow up to 2× the threshold before tripping | Medium (Freeze Audit P1-2) | Resolved |
| DEC-17 | GraceToken offline-budget model: absolute deadline only, or absolute deadline plus a separately-consumed cumulative budget? | (A) `not_after` only (absolute, signed deadline), (B) `not_after` plus `max_offline_budget_ms` with its own consumption state machine | **A** — `max_offline_budget_ms` was carried in an earlier draft with no consumption model ever specified (total vs. per-capability, continuous vs. per-operation, reset-on-reconnect all undefined); removed rather than left ambiguous, since `not_after` alone already satisfies every requirement this plan actually places on offline grace. A genuinely separate cumulative-budget subsystem, if wanted later, is new design work requiring its own decision, not something to silently reintroduce | High (Freeze Audit P1-5) | Resolved (by removal) |
| DEC-18 | `pending_transactions`: integrate into workflows, or remove? | (A) wire it into every operation that might need unknown-outcome recovery (new design work: creation/transition points, cleanup, ownership), (B) remove it — idempotency keys (§6.3) + outbox idempotency (§6.2) + generation-mismatch-triggered reconciliation (§4 Phase 15) already cover every unknown-outcome case in this plan without it | **B** — the table existed in schema but was never created, transitioned, or read by any actual workflow (Freeze Audit P1-1); removing unused, unwired infrastructure is the smaller and more honest correction than inventing a lifecycle for it after the fact | Medium | Resolved (by removal) |

**Genuinely still open** (require a human product/deployment decision, not resolvable by normalizing the plan's own internal consistency): DEC-12 (security/availability tradeoff sign-off on offline-grace TTL values) and DEC-14 (concrete `server_epoch` storage technology for the target deployment environment). Both are explicitly identified here as intentional decisions still owed, per the freeze gate in §25 — they are not hidden, and they are not treated as blocking this plan's IMPLEMENTATION-READY status, since resolving them requires information (the target deployment's infrastructure, and Security's risk tolerance) that a normalization pass over the plan's internal consistency cannot supply on its own. Confirming DEC-06/DEC-09 against the real CP implementation once it's available for byte-level testing remains Phase 4's contract test's job, as before.

---

## 22. Requirements Traceability Matrix

| Component | Requirement | Source | Implementation | Verification |
|---|---|---|---|---|
| Ed25519 signing, domain-separated | INV-01, INV-02 | Core Spec §13, Hostile Audit CRIT-01/02 | `crypto/ed25519.ts`, `protocol/envelope.ts` | Phase 4 contract test |
| Dual-signing key rotation | CRIT-01 | Hostile Audit | `signatures` map, `crypto/keys.ts` | Phase 3/4 rotation test |
| Canonical JSON explicit order | CRIT-02 | Hostile Audit | `protocol/canonical.ts` | byte-for-byte CP fixture test |
| Replay timestamp | CRIT-06 | Hostile Audit | envelope `timestamp` field | Phase 4 security test |
| DB-restore vs forgery | CRIT-05 | Hostile Audit | `server_epoch`, `domain/reconciliation/service.ts` | Phase 15 DB-restore regression test |
| Audit hash chain linearity | CRIT-07 | Hostile Audit | `accounts.last_event_hash` + `FOR UPDATE`, `domain/audit/hash-chain.ts` | Phase 16 concurrency test |
| Payment/license atomicity | CRIT-03/LP-01 | Hostile Audit | `outbox_events`, `outbox/worker.ts` | Phase 10 crash-timeline test |
| Offline-grace forgery resistance | CRIT-04 | Hostile Audit | `GraceToken`, `domain/licensing/grace-token.ts` | Phase 9 signature/expiry test |
| 5→3-scope generation counters, monotonic | B-07/DB-04/EV-15 | Hostile Audit | `account_generation_states`, `machine_session_states`, `backend_trust_state` | Phase 2 migration test, DB trigger test |
| Causal linkage (license↔authorization) | INV-05 | Core Spec §8, §19 | `domain/licensing/service.ts` (co-advances `license_revision`+`authorization_revision` on License Change **only**), `domain/authorization/service.ts` (reads and stamps `license_revision` via `observed_license_revision`, never advances it) | Phase 9/11 unit test, **plus the P0-6 regression test**: repeated `resolve()` calls leave `license_revision` unchanged |
| Capability-based authorization (union set) | DEC-02 | Core Spec §17-18, Hostile Audit | `domain/authorization/capability-registry.ts`, `plan_entitlements` | Phase 11 tier-mapping test |
| Keygen authority model — DB authoritative for authorization, read/write methods split by caller | INV-14, LP-02/EV-10, Freeze Audit P0-5/DEC-15 | Core Spec §19.3, Hostile Audit, Freeze Audit | `domain/licensing/provider.ts` → `adapters/keygen/adapter.ts`; §9.1's read/write caller split | architecture test (read methods never imported from `authorization`/`auth`) + `license-sync` drift test |
| Payment behind adapter, checkout/entitlement-mutation split | — / Freeze Audit P0-4 | Core Spec §20.2, Freeze Audit | `domain/payment/provider.ts` → `adapters/payment/adapter.ts`; §6.1's "Payment Checkout Initiation" row | architecture test (checkout never writes `licenses`/`authorizations`/`subscriptions`) + crash-timeline test |
| Reconciliation idempotent, single path, fails closed on epoch-store unavailability | INV-11, INV-18, Freeze Audit P1-7 | Core Spec §23, Freeze Audit | `domain/reconciliation/service.ts` | Phase 15 idempotency test + epoch-store-unavailable test |
| Revocation immediate, atomic cascade | INV-10, INV-21 | Core Spec §21, Hostile Audit | `domain/revocation/service.ts` | Phase 12 cascade-atomicity test |
| Circuit breaker persisted, fixed window | R-03, Freeze Audit P1-2/DEC-16 | Hostile Audit, Freeze Audit | `revocation_circuit_breaker` table | Phase 12 restart-durability test + boundary-burst test |
| Outbox events cannot permanently wedge | Freeze Audit P0-3 | Freeze Audit | `outbox_events.claimed_at/lease_expires_at/worker_id`, stale-lease reclaim query | Phase 10 crash-recovery regression test (worker killed mid-`PROCESSING`) |
| Admin separate auth path | INV-12 | Core Spec §28 | `admin/auth.ts`, `admin/routes.ts` | Phase 13 route-isolation test |
| Audit append-only, redacted, fail-together with the business mutation it records | INV-16, INV-20, Freeze Audit P2-13 | Core Spec §27, Freeze Audit | `domain/audit/service.ts`, `redactor.ts` | Phase 16 DB-permission test + audit-failure-rolls-back-mutation test |
| Machine signature verified every authenticated request | INV-09 | Core Spec §15.4 | `protocol` middleware, `machines.public_key_hex` | Phase 5 security test |
| Registration bound to authenticated session | S-01/EV-08 | Hostile Audit | `domain/machine/service.ts` | Phase 5 unauthenticated-registration test |
| Rate limiting on auth | Core Spec §14.4 | Core Spec | `api/middleware/rate-limiter.ts` | Phase 7 load test |
| Single active session per machine, safe-to-retry re-authentication | DEC-03, Freeze Audit P1-6 | Core Spec, Freeze Audit | `sessions` partial unique index, §4 Phase 7's revoke-then-replace transaction | Phase 7 concurrent-authentication test |
| FTS hash verification, parallel resume, authoritative/derived ack state | Core Spec §29.3, FT-01/EV-09, Freeze Audit P1-3 | Core Spec, Hostile Audit, Freeze Audit | `transfer/service.ts`, `file_transfer_chunks.acked` (authoritative), `file_transfers.acked_chunks` (derived) | Phase 14 parallel-upload test |
| Guard fields present in Backend responses | CP-08/P-04/EV-17 | Hostile Audit | Phase 6 middleware | contract test per response type |
| Migration executes against a genuinely empty database | Freeze Audit P0-1/P0-2/P0-7 | Freeze Audit | §5's verified table order, `pgcrypto` extension | Phase 2 migration test |
| Module boundaries, no forbidden deps | §2 matrix | Core Spec §31, Hostile Audit MB-01 | `app/` orchestration layer | architecture test (import graph) |

---

## 23. Backend Contract Dependencies

Per the Backend-only boundary rule: where the Backend requires something *from* CP, or provides something *to* CP that CP must act on, this plan states the contract only — it does not implement or modify CP.

| # | What Backend Provides | Why CP Needs It | Contract |
|---|---|---|---|
| 1 | Protocol v2 envelope (`signatures` map, `timestamp`, `server_epoch`) | CP must verify against multiple key versions during rotation, include a timestamp, and track `server_epoch` | Request/response schema in §8.2; CP must update `envelope.mjs` to iterate `signatures` and accept if any verifies |
| 2 | `GraceToken` in `AUTH_RESULT`/`SESSION_RENEW_RESULT` — `account_id`, `machine_id`, `capabilities`, `not_before`, `not_after`, `signature` (no separate offline-budget field — §8.4/DEC-17) | CP's local offline-grace enforcement is currently forgeable (CRIT-04); it must validate a Backend-signed token instead of trusting local state | Schema in §8.4; CP must reject operation if `current_time > not_after` or signature invalid, must maintain `highest_observed_time` to detect clock rollback/freeze, and decides for itself (Backend has no visibility here) whether to gracefully complete or abort an in-flight operation when `not_after` passes mid-execution |
| 3 | Guard fields (`nonceValidated`, `responseValidated`, `backendConfirmed`, `nonceChecked`) in the relevant responses | CP's existing state-machine guards check these exact fields; without them every real Backend response is currently rejected (CP-08) | Field presence per §3 item 18 table — this is a Backend-side fix and does not require CP changes, but CP's guard *logic* should validate crypto natively rather than trusting a boolean flag long-term (documented as a CP-side follow-up, not Backend's to implement) |
| 4 | `server_epoch` value on every response | CP must distinguish "you're behind because of forgery" from "you're behind because of a legitimate Backend restore" | CP stores latest `server_epoch`, presents it in every request; comparison algorithm in §4 Phase 15 |
| 5 | Generation counters serialized as decimal strings | CP currently stores them as JS `number` (float64), which loses precision above 2^53 against Backend's `BIGINT` (CP-11) | Backend emits strings; CP should parse with `BigInt`, not `Number` — a CP-side fix this plan flags but does not implement |
| 6 | `REVOCATION_NOTICE` via WebSocket push + piggyback fallback, delivered best-effort (§4 Phase 12/Freeze Audit P1-12 — not acknowledged, since correctness never depends on delivery) | A revoked CP that only receives revocation via piggyback continues attempting operations until its next contact, though every such attempt is independently rejected server-side regardless | CP should implement (or already implement) a persistent-connection listener for the push path to shorten this window; piggyback remains the fallback if CP doesn't/can't maintain one; CP is not required to acknowledge notices, and Backend does not track delivery-acknowledgment state |
| 7 | Machine registration requiring an authenticated session (S-01 fix) | Closes a key-substitution attack, but means CP cannot register a machine before it has *some* valid session | CP flow ordering: authenticate (possibly `PARTIAL`) → then register machine → then re-resolve authorization |
| 8 | FTS `acked_chunks` range-bitmap status response (replaces `lastAckedChunkIndex`) | Enables correct resume with genuinely parallel, out-of-order chunk uploads | CP's resume logic must read/compute against ranges, not a single integer (EV-09) |
| 9 | Reconciliation rate-limiting under load | Prevents thundering-herd on Backend restart | CP should add randomized jitter before reconnecting/reconciling (Hostile Audit Distributed Systems Engineer finding) — a CP-side behavior this plan flags but does not implement |
| 10 | Ephemeral ECDHE session key exchange (EV-11) | Adds forward secrecy so a compromised long-lived machine key doesn't retroactively decrypt past sessions | CP must perform the ECDHE handshake and derive the AES-256-GCM key via HKDF instead of using the identity key directly for payload confidentiality |

None of the above are implemented by this plan — each is stated as a contract (schema/behavior Backend guarantees) for CP engineering to consume.

---

## 24. Definition of Done

This Backend implementation plan is complete, internally consistent, and implementation-ready when:

**Migration & Schema**
- [ ] `001_initial_schema.sql` applies successfully, in one pass, to a genuinely empty PostgreSQL database — no manual reordering, no forward-reference failures (Freeze Audit P0-1/P0-2 resolved), `pgcrypto` enabled before first use (P0-7).
- [ ] Every table, foreign key, index, and CHECK constraint in §5 exists after migration and is verified by the migration test (§4 Phase 2).
- [ ] No unused, unwired tables remain (`pending_transactions` removed per DEC-18; `licenses.backend_revision` removed per P1-4).
- [ ] The monotonicity trigger covers `machine_session_states`, `account_generation_states`, and `machines.machine_generation` directly (P2-9).

**Transactions & Concurrency**
- [ ] Every transaction boundary in §6.1 is implemented per its stated isolation level, and matches its phase's prose description exactly — in particular, Authorization Resolution never writes `license_revision` (P0-6, with its own regression test), and Payment Checkout Initiation is correctly modeled as a synchronous, state-mutation-free provider call distinct from webhook-driven entitlement mutation (P0-4).
- [ ] The canonical lock order is followed by every multi-lock transaction; the concurrent-authentication test (revoke-then-replace, P1-6) and the authorization-vs-revocation race test both pass.
- [ ] Every idempotency key in §6.3 is enforced at the DB level (unique constraint or status check), not just in application logic.

**Outbox & Background Processing**
- [ ] The outbox's claim/lease mechanism (`claimed_at`, `lease_expires_at`, `worker_id`, `SELECT … FOR UPDATE SKIP LOCKED`) is implemented, and the crash-recovery regression test (worker killed mid-`PROCESSING`, event reclaimed and retried exactly once) passes (P0-3).
- [ ] All six background jobs (§13/Phase 17 — not twenty-two, per the P2-4 correction) run under distributed locking via `scheduled_jobs`; the Outbox Worker's continuous claim loop is verified separately from these six.
- [ ] `license-sync` correctly distinguishes Backend-originated from Keygen-originated changes per §9.1's reconciliation direction.

**Security & Protocol**
- [ ] Protocol v2 is implemented with a working v1 compatibility path; the canonical-JSON contract test passes against a fixture generated from real CP code, using the full byte-level encoder contract in §7.2 (field order, UTF-8, no omitted fields, decimal-string generation/epoch encoding).
- [ ] The replay decision procedure (§8.2.1) is implemented in the exact stated order (parse → version → timestamp → nonce → signature → generation).
- [ ] `GraceToken` issuance (with the finalized, single-deadline model — no `max_offline_budget_ms`) and the `server_epoch` mechanism (failing closed on store unavailability, per P1-7) are both live before any production traffic — these remain the two highest-blast-radius findings if skipped (CRIT-04, CRIT-05).
- [ ] The Keygen authority model (§9.1) is enforced by architecture test: `authorization/resolve` and `authentication` never call any `LicensingProvider` read method; only `license-sync` and Admin do.
- [ ] Transactional Outbox is the **only** path by which Backend makes any provider call that mutates license/authorization/subscription state — enforced by architecture test; checkout-session creation's synchronous, state-mutation-free provider call is confirmed, by the same architecture test, to write nothing to `licenses`/`authorizations`/`subscriptions`.

**Audit & Revocation**
- [ ] Audit hash chain cannot fork under concurrency (Phase 16's concurrency test is the direct regression test for CRIT-07), and a failed audit insert is confirmed to roll back its associated business mutation (P2-13).
- [ ] The revocation circuit breaker is confirmed to be a fixed one-minute window (not rolling), persisted across restarts, and correct under multi-instance concurrency (P1-2/DEC-16).
- [ ] `REVOCATION_NOTICE` delivery is confirmed best-effort — the revocation-evasion adversarial test passes with WebSocket delivery deliberately disabled, proving correctness never depended on it (P1-12).

**File Transfer**
- [ ] `file_transfer_chunks.acked` and `file_transfers.acked_chunks` are confirmed consistent under concurrent, out-of-order chunk uploads, with the authoritative/derived relationship holding (P1-3); the cancellation-race test confirms no chunk can commit after its transfer is cancelled (P2-5).

**Documentation Consistency**
- [ ] No occurrence of "Keygen is write-only," "rolling" (in reference to the circuit breaker), "22 background jobs," `backend_revision`, or `max_offline_budget_ms` remains anywhere in this document outside of this checklist and §21's decision history — a final scan (§25) confirms this.
- [ ] Every cross-reference to a source document section number that has no equivalent content in this plan has been replaced with inlined content (P2-1) — remaining citations are provenance-only and never load-bearing.

**Open, Non-Blocking Decisions**
- [ ] DEC-12 (offline-grace TTL sign-off) and DEC-14 (`server_epoch` storage technology) are explicitly flagged to Security/Product/Infra before Phase 21 begins — these are the only two items in this entire plan requiring a decision beyond what internal-consistency normalization can supply, and they are documented as such, not hidden.
- [ ] Every Backend Contract Dependency (§23) has been communicated to and acknowledged by whoever owns CP implementation.

There are **zero** unresolved P0 or P1 issues in this plan as written.

---

# FINAL IMPLEMENTATION FREEZE

### Architecture status
**Preserved.** No component was replaced, removed, or redesigned. PostgreSQL, the modular monolith, the outbox pattern, Keygen, the payment-provider adapter model, the Backend/CP boundary, capability-based authorization, and the signed protocol are all exactly as originally architected. Every change in this document is a normalization: a schema reorder, a column addition (`claimed_at`/`lease_expires_at`/`worker_id`, `observed_license_revision`), a column removal (`backend_revision`, `pending_transactions`, `max_offline_budget_ms`), a narrowed or corrected invariant statement, or an explicit transaction sequence spelled out where one was previously implicit. Nothing here required inventing new infrastructure (no microservices, no event sourcing, no message broker, no distributed consensus, no additional database).

### P0 status
All seven — **RESOLVED**:
`RESOLVED` — P0-1 (migration forward-reference, `authorizations`→`licenses`)
`RESOLVED` — P0-2 (migration forward-reference, `revocation_circuit_breaker`→`admin_users`)
`RESOLVED` — P0-3 (outbox lease/claim/reclaim mechanism)
`RESOLVED` — P0-4 (payment checkout synchronicity, scoped correctly)
`RESOLVED` — P0-5 (Keygen authority model, read/write split, reconciliation direction)
`RESOLVED` — P0-6 (authorization resolution no longer advances `license_revision`)
`RESOLVED` — P0-7 (`pgcrypto` extension added ahead of first use)

### P1 status
All twelve — **RESOLVED**, except two intentionally-flagged product/deployment decisions that a normalization pass cannot itself make:
`RESOLVED` — P1-1 (`pending_transactions` removed, per DEC-18) · `RESOLVED` — P1-2 (circuit breaker documented as fixed-window, per DEC-16) · `RESOLVED` — P1-3 (FTS ack-state authority defined) · `RESOLVED` — P1-4 (`backend_revision` removed) · `RESOLVED` — P1-5 (`max_offline_budget_ms` removed, per DEC-17) · `RESOLVED` — P1-6 (re-authentication transaction sequence specified) · `RESOLVED` — P1-7 (epoch-store-unavailable fails closed) · `RESOLVED` — P1-8 (naming corrected) · `RESOLVED` — P1-9 (replay decision procedure specified) · `RESOLVED` — P1-10/P1-11 (canonical encoder contract specified) · `RESOLVED` — P1-12 (revocation delivery documented as best-effort).
**Intentional, explicitly identified, not hidden**: DEC-12 (offline-grace TTL values need Security sign-off) and DEC-14 (server-epoch storage technology needs a deployment-target decision) remain open because they require information outside this document's scope — not because they were overlooked.

### P2 status
All fifteen addressed; none require an engineer to make an architectural decision — every P2 item was a naming fix, a dangling cross-reference, a missing FK, a documentation clarification, or a new test name.

### Contradiction status
**0 unresolved internal contradictions.** The ten-row Contradiction Matrix the freeze audit produced (C-1 through C-10) is fully closed: every row's "Required Correction" has been applied at its cited section, and the corrected wording is what now appears there — there is no surviving instance of the old, contradicted wording anywhere in this document.

### Implementation status
**IMPLEMENTATION-READY.** An engineer can implement this Backend from this document alone, in the phase order given in §19, without needing to reinterpret the architecture, guess at an undefined transaction boundary, or silently resolve a contradiction between two sections. The two remaining open items (DEC-12, DEC-14) are product/deployment decisions explicitly flagged for sign-off before Phase 21, not implementation ambiguities — every phase through Phase 20 can proceed against this document exactly as written.
