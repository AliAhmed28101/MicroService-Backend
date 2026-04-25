# Time-Off Microservice (TOMS)

> ExampleHR take-home assessment — NestJS + SQLite time-off management microservice

## Tech Stack

- **Runtime**: Node.js 20+
- **Framework**: NestJS 10
- **Database**: SQLite via TypeORM (`better-sqlite3`)
- **Testing**: Jest (unit + e2e), Supertest
- **Docs**: Swagger UI at `/api`

---

## Quick Start

### Prerequisites

- Node.js 20+ ([https://nodejs.org](https://nodejs.org))
- npm 9+

### 1. Clone and install

```bash
cd D:\MicroService
npm install
```

### 2. Configure environment

Copy the provided `.env` file (already included). Defaults work out of the box:

```
HCM_BASE_URL=http://localhost:4000
DATABASE_PATH=./data/toms.db
PORT=3000
```

### 3. Start the server

```bash
npm run start:dev
```

The server starts at **http://localhost:3000**

Swagger docs: **http://localhost:3000/api**

---

## API Endpoints

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness check |

### Balances
| Method | Path | Description |
|--------|------|-------------|
| GET | `/balances/:employeeId/:locationId` | All leave type balances |
| GET | `/balances/:employeeId/:locationId/:leaveType` | Single leave type balance |
| POST | `/balances/sync` | Trigger on-demand batch sync from HCM |
| GET | `/balances/sync/status` | Last sync result |

### Time-Off Requests
| Method | Path | Description |
|--------|------|-------------|
| POST | `/time-off-requests` | Submit a new request |
| GET | `/time-off-requests` | List requests (filter by employeeId, status) |
| GET | `/time-off-requests/:id` | Get a single request |
| PATCH | `/time-off-requests/:id/approve` | Manager approves |
| PATCH | `/time-off-requests/:id/reject` | Manager rejects |
| PATCH | `/time-off-requests/:id/cancel` | Employee cancels |

---

## Running Tests

### Unit tests (with coverage)

```bash
npm run test:cov
```

Coverage report is written to `./coverage/`. Open `coverage/lcov-report/index.html` in a browser.

### E2E tests (spins up real NestJS app + mock HCM server)

```bash
npm run test:e2e
```

The e2e suite:
- Starts a real NestJS application with an in-memory SQLite database
- Boots a **mock HCM server** on port 4099 that simulates real HCM behaviour:
  - Balance GET, debit, commit, rollback
  - Batch endpoint
  - Anniversary accrual (`triggerAnniversary`)
  - Year-start reset (`triggerYearReset`)
- Runs full request lifecycle tests (submit → approve/reject/cancel)
- Tests balance integrity (double-spend prevention)
- Tests idempotency
- Tests HCM-initiated balance changes picked up by batch sync

---

## Project Structure

```
src/
├── main.ts                         # App bootstrap + Swagger
├── app.module.ts                   # Root module
├── health.controller.ts            # GET /health
├── common/
│   ├── enums.ts                    # LeaveType, RequestStatus
│   └── entities/
│       └── idempotency-record.entity.ts
├── balance/
│   ├── balance.module.ts
│   ├── balance.service.ts          # Core balance R/W, pessimistic locking
│   ├── balance.controller.ts       # GET /balances/...
│   ├── balance.service.spec.ts     # Unit tests
│   ├── dto/balance.dto.ts
│   └── entities/leave-balance.entity.ts
├── time-off-request/
│   ├── time-off-request.module.ts
│   ├── time-off-request.service.ts # Full request lifecycle + saga
│   ├── time-off-request.controller.ts
│   ├── time-off-request.service.spec.ts
│   ├── dto/time-off-request.dto.ts
│   └── entities/time-off-request.entity.ts
└── hcm-sync/
    ├── hcm-sync.module.ts
    ├── hcm-adapter.service.ts      # Outbound HCM HTTP calls + retry
    ├── hcm-sync.service.ts         # Batch scheduler + dead-letter retry
    ├── hcm-sync.controller.ts      # POST /balances/sync
    ├── hcm-sync.service.spec.ts    # Unit tests
    └── entities/sync-error.entity.ts

test/
├── mock-hcm-server.ts              # Mock HCM server (Node http)
├── app.e2e-spec.ts                 # E2E integration tests
└── jest-e2e.json
```

---

## Key Design Decisions

### Balance Integrity
Balances use a three-field model: `totalBalance`, `usedBalance`, `pendingBalance`.
Available = total − used − pending. All mutations run inside a TypeORM transaction
with a QueryRunner so the balance and request row are always atomically consistent.

### Idempotency
Every `POST /time-off-requests` requires an `idempotencyKey` (UUID). Duplicate
submissions within the TTL window (default 24h) return the original response without
re-running any business logic.

### HCM Sync
- **Real-time**: Each request submission calls `POST /hcm/debit` on the HCM.
  If HCM rejects, the request is immediately set to `REJECTED` and pending balance released.
- **Batch**: A scheduled cron (every 15 min) calls `POST /hcm/batch` to reconcile
  the full balance corpus. This handles HCM-side changes (anniversaries, year-start resets)
  that happen independently of ExampleHR.

### Retry / Dead-letter
Failed batch sync rows are written to `sync_errors`. A secondary cron retries them
with exponential back-off (1m → 5m → 30m) up to 3 attempts.

---

## Seeding Test Data via Swagger

Visit **http://localhost:3000/api** and use the `POST /balances/sync` endpoint after
seeding a balance directly through a SQLite tool, or run the e2e tests which auto-seed
via the mock HCM server.