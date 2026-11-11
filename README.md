# Secure File Transfer (Experiment 1B)

This repository is being developed incrementally for UCAS *Software and System Security* Experiment 1B. Phase 1 contains the architecture and protocol draft plus a minimal Vue/Node WebSocket heartbeat demonstration. File transfer, authentication, TLS, and database features are intentionally deferred.

## Quick start on Windows 11

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Open <http://localhost:5173>. The browser connects to `/ws` through Vite's development proxy, completes the custom `HELLO` exchange, and answers server heartbeat messages.

```powershell
npm run build
npm test
```

See [`docs/requirements.md`](docs/requirements.md), [`docs/architecture.md`](docs/architecture.md), [`docs/protocol-draft.md`](docs/protocol-draft.md), and [`docs/phase-plan.md`](docs/phase-plan.md).

