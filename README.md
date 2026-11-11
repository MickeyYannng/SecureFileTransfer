# Secure File Transfer (Experiment 1B)

This repository is being developed incrementally for UCAS *Software and System Security* Experiment 1B. Phase 2.1 adds SQLite migrations, Argon2id user authentication, revocable WebSocket sessions, per-user storage isolation, and a login/file-browser GUI foundation. File upload/download and TLS are intentionally deferred.

## Quick start on Windows 11

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Open <http://localhost:5173>. The browser connects to `/ws` through Vite's development proxy, completes the custom `HELLO` exchange, and answers server heartbeat messages.

## Initialize Alice and Bob

Set local test passwords in the ignored `.env` file. Never commit that file.

```dotenv
SFT_SEED_ALICE_PASSWORD=<choose-a-local-test-password>
SFT_SEED_BOB_PASSWORD=<choose-a-different-local-test-password>
```

Then apply migrations and create the two users idempotently:

```powershell
npm run db:init --workspace @sft/server -- --seed-test-users
```

Running the command without `--seed-test-users` only applies migrations. Passwords and raw session tokens are never stored in logs or the database; the database contains Argon2id password hashes and SHA-256 token lookups.

```powershell
npm run build
npm test
```

See [`docs/requirements.md`](docs/requirements.md), [`docs/architecture.md`](docs/architecture.md), [`docs/protocol-draft.md`](docs/protocol-draft.md), [`docs/phase-plan.md`](docs/phase-plan.md), and [`docs/phase-2.1.md`](docs/phase-2.1.md).

