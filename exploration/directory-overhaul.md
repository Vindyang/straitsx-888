# straitsx-888 directory overhaul — decouple the merchant x402 server from the agentic payment architecture

**Status:** approved plan (not yet executed). **Date:** 2026-08-19.

This document records the agreed overhaul of the `straitsx-888` repository layout. Its one goal:
make the **merchant x402 server** a first-class, independently built/deployed code unit instead of
a hidden twin of the agent-orchestrator. It does not change the wire contracts, the run-source
API, or the AWS deployment topology beyond repointing the existing `fixture` task at a new image.

## 1. Confirmed decisions

| # | Decision | Choice |
| --- | --- | --- |
| D1 | Top-level placement | New **`merchants/`** top-level directory (e.g. `merchants/mock-luckin`), not `services/mock-luckin` |
| D2 | Merchant scope | **Grow the fixture server into a real x402 merchant** during the move — catalog + `/.well-known/x402-menu.json` + 402 challenge + checkout + confirmation, keeping the poisoned-page fixtures |
| D3 | Merchant automation config | `MERCHANT_PROFILES` **stays in agent-orchestrator** (checked-in consumer allowlist = payment-architecture safety control); the `MerchantProfile` **type** moves to `packages/contracts` |
| D4 | Env / script rename | **Yes** — `FIXTURE_PORT`/`FIXTURE_BASE_URL` → `MERCHANT_PORT`/`MERCHANT_BASE_URL`; `dev:fixtures` → `dev:merchant` |

## 2. Why — the coupling today

The "merchant x402 server" is **already a separate AWS task but not a separate code unit**.
Inside `services/agent-orchestrator/`, two concerns share one `package.json`, one Dockerfile, and
one env section:

| Concern | Files |
| --- | --- |
| **Merchant x402 server (producer)** | `src/discovery/fixture-server.ts`, `src/discovery/fixtures/*.html`, `src/checkout/merchant-profiles.ts` |
| **Agentic payment architecture (consumer)** | `src/card-gateway/*`, `src/clients/*`, `src/run/pipeline.ts`, `src/run/store.ts`, `src/routes/*`, `src/discovery/discover.ts`, `src/checkout/checkout-worker.ts`, `src/checkout/ucp-checkout.ts`, `src/post-issuance/*` |

Meanwhile the deployment already treats it as its own service: `infra/module-c/main.tf` declares a
`fixture` ECS task + security group + Cloud Map name on port 4010, with command
`pnpm --filter @straitsx/agent-orchestrator fixtures`.

Consequences of the current coupling:

- The merchant image inherits the **~1.6 GB Playwright base image** (`mcr.microsoft.com/playwright`)
  plus fastify + viem, just to serve 4 static HTML pages.
- The orchestrator Dockerfile exposes **`EXPOSE 4005 4010`** — one image, two roles.
- `FIXTURE_*` env vars and the `dev:fixtures` script are routed through the orchestrator package.
- `modules/module-c-agent-and-surfaces.drawio` draws the merchant as a **private task inside the
  payment boundary** instead of as the untrusted counterparty it is.

## 3. Target layout

```
straitsx-888/
├── packages/contracts/            # shared wire types — adds MerchantProfile, X402Menu
├── services/                      # THE AGENTIC PAYMENT ARCHITECTURE (trusted core)
│   ├── agent-orchestrator/        # consumer side only:
│   │                              #   card-gateway, clients, run SM, routes, discover.ts,
│   │                              #   checkout-worker.ts, ucp-checkout.ts, post-issuance/*,
│   │                              #   merchant-profiles.ts (keep — consumer allowlist)
│   └── policy / signer / chain-gateway / ledger / dashboard
└── merchants/                     # MERCHANT X402 SERVERS (untrusted counterparty)  ← NEW
    └── mock-luckin/               # grown from fixture-server into a real x402 merchant
        ├── src/main.ts app.ts
        ├── src/routes/            # catalog, checkout, confirmation, poisoned fixtures
        ├── src/well-known.ts      # /.well-known/x402-menu.json (structured catalog)
        ├── src/fixtures/*.html    # poisoned-page fixtures stay here (they ARE merchant pages)
        ├── test/
        └── Dockerfile             # node:22-alpine + fastify — NO Playwright
```

**The dividing line:** the merchant's *server side* (pages, 402 challenges, menu) moves out. The
agent's *client side* (browser worker, UCP completion, domain assertion, discovery scraping) stays
in the orchestrator — it is the consumer of the merchant, not the merchant itself.

## 4. Step-by-step moves

1. **Create `merchants/mock-luckin`** (name `@straitsx/mock-luckin`, deps only on
   `@straitsx/contracts` + fastify). Move `fixture-server.ts` → merchant `app.ts` + routes
   (product page, checkout, confirmation, `/.well-known/x402-menu.json`, poisoned fixtures). Move
   the 4 HTML fixtures as-is.
2. **Slim the orchestrator Dockerfile**: remove `EXPOSE 4010`; keep Playwright (checkout-worker /
   discover still need it). New `Dockerfile` for mock-luckin on `node:22-alpine`, healthcheck
   `/health`.
3. **`pnpm-workspace.yaml`**: add `"merchants/*"`.
4. **Root `package.json`**: `dev:fixtures` → `dev:merchant`
   (`pnpm --filter @straitsx/mock-luckin dev`); `dev:orchestrator` unchanged.
5. **`packages/contracts`**: add `MerchantProfile` + `X402Menu` types (the only cross-service
   dependency — merchant and orchestrator both import them). Re-export via `index.ts`.
6. **`merchant-profiles.ts`**: stays in orchestrator (consumer allowlist); drop the hard-coded
   `http://localhost:4010` default → read `MERCHANT_BASE_URL`; `MERCHANT_PROFILES["local-fixture"]`
   keeps its shape. `checkout-worker.test.ts` (`getMerchantProfile("local-fixture")`) keeps passing.
7. **Env + docs**: `.env.example` `FIXTURE_PORT`/`FIXTURE_BASE_URL` → `MERCHANT_PORT`/
   `MERCHANT_BASE_URL` (both merchant and orchestrator sections). `docs/conventions.md`: add
   `merchants/` to layout + rule "merchants import `packages/contracts`; orchestrator never imports
   merchant source — HTTP only, same rule as services". Update `docs/demo-runbook.md`
   (`dev:merchant`, `MERCHANT_BASE_URL`), `docs/owner-c-tasks.md` C7 phrasing,
   `docs/module-c-aws-integration-handover.md` (image/port wording).
8. **Terraform `infra/module-c/main.tf`**: point `fixture_image`/`fixture` task at the new merchant
   image + entrypoint; SG/SD names may stay or rename `-fixture` → `-merchant`. Update
   `terraform.tfvars.example` + `variables.tf` accordingly.
9. **`scripts/publish-module-c-images.sh`**: build/push a separate `merchants/mock-luckin` image;
   emit a `merchant_image` output (keep `fixture_image` for backward-compat with tfvars, or rename
   both consistently).
10. **Dashboard**: no required changes — `run-console.tsx` keeps the fixture/merchant source picker
    (the `fixture`/`merchant` run-source distinction is a *consumer* API, unaffected by where the
    merchant code lives).
11. **Diagrams** (`modules/module-c-agent-and-surfaces.drawio` + root `Straitsx.drawio`): redraw the
    fixture cell as `merchants/mock-luckin` on the untrusted side of the network boundary;
    orchestrator shows only HTTP egress to it.

## 5. File-by-file inventory

### Moved out of `services/agent-orchestrator/` into `merchants/mock-luckin/`

| From | To |
| --- | --- |
| `src/discovery/fixture-server.ts` | `src/app.ts` + `src/routes/*` |
| `src/discovery/fixtures/clean.html` | `src/fixtures/clean.html` |
| `src/discovery/fixtures/poisoned-recipient.html` | `src/fixtures/poisoned-recipient.html` |
| `src/discovery/fixtures/poisoned-amount.html` | `src/fixtures/poisoned-amount.html` |
| `src/discovery/fixtures/wrong-item.html` | `src/fixtures/wrong-item.html` |

### New / changed

| File | Change |
| --- | --- |
| `merchants/mock-luckin/package.json` | new — `@straitsx/mock-luckin`, `dev`/`start` scripts |
| `merchants/mock-luckin/Dockerfile` | new — node:22-alpine, no Playwright |
| `merchants/mock-luckin/src/routes/*` | new — catalog, checkout, confirmation, fixtures |
| `merchants/mock-luckin/src/well-known.ts` | new — `/.well-known/x402-menu.json` |
| `merchants/mock-luckin/test/*` | new — catalog/challenge/confirmation route tests |
| `packages/contracts/src/merchant.ts` | new — `MerchantProfile`, `X402Menu` types (+ `index.ts` export) |
| `pnpm-workspace.yaml` | add `merchants/*` |
| `package.json` (root) | `dev:fixtures` → `dev:merchant` |
| `services/agent-orchestrator/Dockerfile` | remove `EXPOSE 4010` |
| `services/agent-orchestrator/src/checkout/merchant-profiles.ts` | use `MERCHANT_BASE_URL` |
| `.env.example` | `FIXTURE_*` → `MERCHANT_*` |
| `infra/module-c/main.tf` | `fixture` task → merchant image/entrypoint |
| `infra/module-c/{terraform.tfvars.example,variables.tf}` | `merchant_image` |
| `scripts/publish-module-c-images.sh` | build + push merchant image |
| `docs/conventions.md` | `merchants/` layout + import rule |
| `docs/demo-runbook.md`, `docs/owner-c-tasks.md`, `docs/module-c-aws-integration-handover.md` | wording/ports |
| `modules/module-c-agent-and-surfaces.drawio`, `Straitsx.drawio` | merchant cell across the boundary |

### Untouched (consumer API is stable)

- `services/agent-orchestrator/src/routes/run.ts` — `POST /run` source shapes (`fixture` /
  `merchant`) unchanged.
- `services/agent-orchestrator/src/run/pipeline.ts`, `store.ts` — state machine unchanged.
- `services/agent-orchestrator/src/discovery/discover.ts`, `checkout/checkout-worker.ts`,
  `checkout/ucp-checkout.ts`, `post-issuance/*` — consumer side stays.
- `services/dashboard/*` — no required changes.
- Tests that pass today keep passing: `test/app.test.ts`, `test/run/pipeline.test.ts`,
  `test/post-issuance/checkout-worker.test.ts`.

## 6. Verification

- `corepack pnpm install` (workspace picks up the new package) → `corepack pnpm typecheck` →
  `corepack pnpm test`. Orchestrator tests must stay green since the consumer API is untouched.
- New `merchants/mock-luckin/test` unit tests for catalog/challenge/confirmation routes.
- Manual demo: `pnpm dev:merchant` then `pnpm dev:orchestrator`; run a clean fixture.
- `docker build` both images — assert the merchant image contains no Playwright.

## 7. Risks / open items

- The run-source API (`fixture`/`merchant` on `POST /run`) is intentionally unchanged — it is the
  orchestrator's *input contract*, not the merchant's location.
- The AWS `fixture` task keeps its name/labels (just repointed at the new image), so there is no
  re-provisioning churn; only the image digest changes.
- Dashboard labels (`FIXTURES` const, "fixture" option text) are optional polish, not required.
- This overhaul edits files **inside `straitsx-888`** — that is the point of the task and is distinct
  from the earlier "docs outside straitsx-888 only" constraint (which applied to the diagram /
  Figma session).
