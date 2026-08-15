# Conventions — layout, communication, naming

**Status:** descriptive first, prescriptive second. Everything in §1–§5 is what the code
already does; §6 lists the places the three owners diverged and names the single answer to
converge on. If you are adding a file, follow this doc. If this doc and the code disagree,
the code is the bug — say so in review.

Companion docs: [api-contracts.md](api-contracts.md) is authoritative for **wire shapes**;
this doc is authoritative for **how the repo is arranged and named**. Facts are resolved in
[execution_plan.md §19](execution_plan.md).

---

## 1. Repository layout

```
/
├── CLAUDE.md                    agent instructions (checked in)
├── package.json                 workspace root — scripts, pnpm, devDeps
├── pnpm-workspace.yaml          packages/contracts + services/*
├── tsconfig.base.json           the ONE compiler config; everything extends it
├── tsconfig.json                root project — globs every src/ and test/
├── vitest.config.ts             root test runner — globs every test/
├── .env.example                 every env var, documented, no values
│
├── packages/
│   ├── contracts/               shared TypeScript. The only cross-service dependency.
│   │   ├── src/                 types, constants, errors, http, validation, x402, abi…
│   │   ├── test/
│   │   └── registry.json        deployed addresses + ABI (generated, committed)
│   └── contracts-sol/           Foundry. Solidity only. Not in the pnpm workspace.
│       ├── src/  test/  script/
│
├── services/<service-name>/
│   ├── src/
│   │   ├── main.ts              process entry — reads env, listens. Nothing else.
│   │   ├── app.ts               buildApp() — wires routes, returns a Fastify instance
│   │   ├── routes/              one file per endpoint group
│   │   └── clients/             outbound HTTP to other services
│   └── test/                    mirrors src/, `*.test.ts`
│
├── scripts/                     repo tooling, run with tsx
├── docs/                        specs, task boards, this file
└── modules/                     .drawio architecture diagrams
```

**Rules that follow from the layout:**

- `packages/contracts` is the **only** package a service may import from. Services never
  import each other's source — they call over HTTP.
- A service directory is self-contained: delete it and the rest still typechecks.
- No `dist/`. The workspace is **source-first**: `packages/contracts` exports `./src/index.ts`
  directly, `tsconfig.base.json` sets `noEmit`, and services run under `tsx`. There is no
  build step and nothing imports a build artefact.
- `packages/contracts-sol` is deliberately **outside** the pnpm workspace (it has no
  `package.json`). Solidity is built and tested with `forge`, never with pnpm.

---

## 2. Service topology — who may call whom

| Service | Port | May be called by |
| --- | --- | --- |
| ledger-service | 4001 | policy-service, dashboard, agent-orchestrator |
| policy-service | 4002 | agent-orchestrator, dashboard |
| **signer-service** | **4003** | **policy-service ONLY — enforced at the network layer** |
| chain-gateway | 4004 | policy-service, dashboard |
| agent-orchestrator | 4005 | dashboard |
| dashboard | 3000 | human |

Ports live in one place — `SERVICE_PORTS` in `packages/contracts/src/constants.ts`. Never
hardcode a port number in a service.

Two directional rules are load-bearing, not stylistic:

- **Only chain-gateway opens an RPC connection.** No other service imports `viem` transport.
- **Only signer-service holds key material**, and only policy-service may reach it. The
  isolation is a firewall rule, not an `if` in code ([owner-a-tasks.md A15](owner-a-tasks.md)).
  A code check would prove the port was reachable; the point is that it is not.

---

## 3. How services communicate

### Over the wire

Every service-to-service call is HTTP/1.1 + JSON with two headers:

```
content-type: application/json
x-internal-token: <shared secret>
```

- Applied by `registerInternalAuth(app, token)` from `@straitsx/contracts`. Do not
  reimplement it — it does a constant-time compare and **fails closed** when the token is
  unset.
- `/health` is the only exempt path, deliberately: A15's isolation test asserts the
  *connection* is refused, and a `401` would prove the opposite.

`requestId` (client-generated UUIDv4) is the **idempotency key across every service**. Echo
the caller's rather than minting a second identity — `resolveRequestId(req)` does this.

### Errors

Every non-2xx from every service is the same envelope, produced by `registerErrorHandler(app)`
and thrown as `AppError`:

```json
{ "error": { "code": "MANDATE_NOT_FOUND", "message": "…", "requestId": "3f6c…", "retryable": false } }
```

Status ladder: `400` validation · `401` bad token · `403` caller not allowed · `404` unknown
id · `409` idempotency/conditional-write conflict · `422` policy refusal · `502` upstream
failed · `503` required dependency unavailable · `504` upstream timeout.

> Never put a PAN, private key, KMS key id, raw signature, or card iframe URL in an error
> body or a log line.

### Outbound calls

One module per upstream service under `src/clients/`, named `<service>Client.ts`, exporting
one function per endpoint. Each module owns its base URL and token, and collapses transport
detail into a domain result — `getIntent` returns `IntentRecord | null`, mapping `404` to
`null` rather than leaking a `Response` to callers.

### In-process

- **Route registrars.** `registerXRoute(app)` per endpoint group in `src/routes/`; `app.ts`
  calls them in order and returns the instance. `main.ts` only reads env and listens — this
  is what lets tests build an app without binding a port.
- **Pure checks.** Policy checks are `(ctx: CheckContext) => CheckFailure | null` with **no
  I/O, no env reads, no clock reads**. The pipeline pre-loads everything into `CheckContext`.
  That is what makes each check unit-testable in isolation, which is the B10–B19 deliverable.
- **One implementation of `hashPolicy`.** It lives in `packages/contracts/src/mandate.ts` and
  is imported by policy-service and the dashboard alike. Reimplementing it makes check 2 fail
  permanently and look like a contract bug for hours.

---

## 4. Naming

### Files

| Kind | Convention | Examples |
| --- | --- | --- |
| Multi-word module | **kebab-case** | `build-revoke.ts`, `token-constants.ts`, `check4-recipient-pinned.ts` |
| Single-word module | lowercase | `app.ts`, `store.ts`, `matcher.ts`, `errors.ts` |
| Process entry point | `main.ts` | `services/*/src/main.ts` |
| Barrel / re-export only | `index.ts` | `packages/contracts/src/index.ts` |
| Test | mirrors its subject | `settlement.ts` → `settlement.test.ts` |
| Test double | `fake<Thing>.ts` under `test/fakes/` | `fakeLedger.ts`, `fakeSigner.ts` |
| Solidity contract | **PascalCase** | `MandateRegistry.sol`, `IMandateRegistry.sol` |
| Solidity test / script | `.t.sol` / `.s.sol` | `MandateRegistry.t.sol`, `Deploy.s.sol` |

`index.ts` means "barrel" and nothing else. A file that starts a process is `main.ts`, so a
reader can tell the two apart without opening them.

### Functions

camelCase, **verb first**. The prefix carries meaning — keep it honest:

| Prefix | Contract | Example |
| --- | --- | --- |
| `get*` / `read*` | returns data, may return `null` for absent | `getIntent`, `readTokenFacts` |
| `build*` | pure construction, no I/O | `buildApp`, `buildTypedData` |
| `register*Route` | mounts endpoints on a Fastify instance | `registerBalanceRoute` |
| `parse*` | validates **and returns a normalised value**; throws on bad input | `parseAddress`, `parseX402Challenge` |
| `require*` | validates, throws if missing; no normalisation | `requireEnv`, `requireObject` |
| `assert*` | throws on invariant violation, returns nothing | `assertDecimals`, `assertTokenDecimalsAtBoot` |
| `is*` | returns `boolean`, never throws | `isSupportedChainId` |
| `resolve*` | picks one value from several candidate sources | `resolveRequestId` |

**One deliberate exception:** the check functions are `snake_case` —
`check4_recipient_pinned`, `precondition_intent_exists`. The function name is **character-for-
character the `check` string on the wire** ([api-contracts.md §6](api-contracts.md)). A judge
reads that string off the refusal panel; keeping the identifier identical means grep finds the
code from the screen. Do not "fix" these to camelCase.

### Types

PascalCase, declared in `packages/contracts/src/types.ts` when shared across services, and
locally when not. Shared types are named for the **wire shape** they describe —
`X402Requirements`, `MandateReadResponse`, `SettlementConfirmRequest`, `SignResponse` — so a
reader can find the matching §  in api-contracts.md.

Request/response pairs are `<Thing>Request` / `<Thing>Response`. Stored records are
`<Thing>Record` (`IntentRecord`, `EscalationRecord`). Function types end in `Fn` (`CheckFn`).

### Constants and stores

- `SCREAMING_SNAKE_CASE` for frozen module-level constants: `XSGD_DECIMALS`, `SERVICE_PORTS`,
  `MANDATE_REGISTRY_ABI`, `CARDAPI_SANDBOX_ISSUE_CARD`.
- `camelCase` for mutable module-level state: `intents`, `policies`, `escalations`,
  `decisionLog`. The case difference is the signal that one of these can change under you.
- `ErrorCode` is a PascalCase object used as an enum; its **members** are
  `SCREAMING_SNAKE_CASE` and are part of the wire contract — Owner B parses `code`, so
  renaming one is a breaking change.

### Error codes

`SCREAMING_SNAKE_CASE`, named for the condition, not the status: `MANDATE_NOT_FOUND`,
`NONCE_ALREADY_RESERVED`, `POLICY_HASH_DRIFT`, `SIGNER_WRONG_RECIPIENT`,
`DEPENDENCY_UNAVAILABLE`. Signer-rail refusals
are prefixed `SIGNER_` because they are structural invariants, distinct from policy refusals.

### Environment variables

`SCREAMING_SNAKE_CASE`, grouped in `.env.example` by the service that reads them, with a
comment saying **why**. Per-chain values take the chain id as a suffix: `RPC_URL_43113`,
`RPC_URL_43114`. Every var must appear in `.env.example` with an empty or placeholder value.

Read required vars through `requireEnv(name)` so a misconfigured service **fails at boot, not
at the first request**. A signer that starts misconfigured and discovers it mid-signature is
the failure mode this prevents.

---

## 5. Data encoding — non-negotiable

These come from [api-contracts.md §0](api-contracts.md) and cause silent, expensive bugs when
broken:

| Rule | Value |
| --- | --- |
| Money | base-unit **decimal string**, never a JSON number. `"5000000"` is 5 XSGD. |
| `decimals` | **6** on Fuji and mainnet. Never assume 18. |
| Addresses | EIP-55 checksummed in JSON; **compared lowercased**, always |
| Hex | `0x`-prefixed lowercase, even length |
| Chain time | unix seconds (number) |
| Log time | ISO-8601 UTC string |

Compare money as `BigInt` or as strings via the shared helpers — never as JS numbers. `2^53`
and float rounding both bite, and a mis-encoded value produces a signature that verifies
against the wrong amount.

---

## 6. Known divergences — converge on the right-hand column

Owners A and B scaffolded independently before the merge. These are real inconsistencies in
the tree today, listed so nobody has to guess which side is the convention.

| Thing | Today | Converge on | Priority |
| --- | --- | --- | --- |
| Service entry point | A: `src/main.ts` · B: `src/index.ts` | **`main.ts`** — `index.ts` means barrel | low, mechanical |
| Multi-word filenames | A: `kebab-case` · B: `camelCase` (`ledgerClient.ts`, `typedData.ts`) | **kebab-case** — it is the majority and matches the route/check files | low, mechanical |
| Relative imports | 47 with `.js`, 27 without | **extensionless** — the toolchain is Bundler resolution with no emit, so the extension buys nothing | lowest; both resolve correctly today |
| App factory | A: `buildApp` / `buildSignerApp` · B: `buildApp` | **`buildApp`** everywhere; the file it lives in already disambiguates | low |

> None of these are correctness bugs — the tree typechecks and all tests pass as-is. Fix them
> when you are already editing the file, not as a sweep during the build.

---

## Never

- Import one service's source from another service — call it over HTTP
- Hardcode a port; use `SERVICE_PORTS`
- Reimplement `hashPolicy`, the error envelope, or the internal-auth hook
- Let a check function do I/O, read env, or read the clock
- Put validation logic in ledger-service, or storage logic in policy-service
- Let anything but chain-gateway open an RPC connection
- Log a signature, a full KMS key id, typed-data message contents, `cardHtml`, or a card
  iframe URL
- Rename an `ErrorCode` member or a `check*` identifier without updating
  [api-contracts.md](api-contracts.md) — both are wire contract
