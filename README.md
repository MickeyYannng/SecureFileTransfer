# Secure File Transfer (Experiment 1B)

This repository implements the UCAS *Software and System Security* Experiment 1B with HTTPS/WSS, custom chunked WebSocket upload/download, authentication, user isolation, SHA-256, heartbeat, and up to three concurrent GUI transfer tasks per user.

## Quick start on Windows 11

```powershell
Copy-Item .env.example .env
npm install
npm run cert:generate
powershell -ExecutionPolicy Bypass -File scripts\trust-dev-ca.ps1
powershell -ExecutionPolicy Bypass -File scripts\configure-storage-acl.ps1
npm run dev
```

Open <https://127.0.0.1:5173>. The browser validates the locally trusted development CA and connects directly to `wss://127.0.0.1:3000/ws`.

## Initialize Alice and Bob

Set local test passwords in the ignored `.env` file. Never commit that file.

```dotenv
SFT_SEED_ALICE_PASSWORD=<choose-a-local-test-password>
SFT_SEED_BOB_PASSWORD=<choose-a-different-local-test-password>
```

Then apply migrations and create the two users idempotently:

```powershell
npm run db:seed --workspace @sft/server
```

Running the command without `--seed-test-users` only applies migrations. Passwords and raw session tokens are never stored in logs or the database; the database contains Argon2id password hashes and SHA-256 token lookups.

```powershell
npm run build
npm test
# Optional separate 100 MiB real upload test:
npm run test:slow-upload --workspace @sft/server
npm run test:slow-download --workspace @sft/server
```

After login, select multiple files for upload or click **下载** on several server files. The task list displays independent progress, speed, state, and cancellation. Edge/Chrome use File System Access API plus OPFS for bounded-memory downloads; other browsers use a 32 MiB fallback.

See [`docs/requirements.md`](docs/requirements.md), [`docs/architecture.md`](docs/architecture.md), [`docs/protocol-draft.md`](docs/protocol-draft.md), [`docs/phase-plan.md`](docs/phase-plan.md), [`docs/phase-2.1.md`](docs/phase-2.1.md), [`docs/phase-2.2.md`](docs/phase-2.2.md), and [`docs/phase-2.3.md`](docs/phase-2.3.md).

