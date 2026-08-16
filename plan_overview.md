# Plan Overview — signer-service Phase 3 (A11–A16)

**Status:** Ready for delegation. This plan decomposes the real-signer build into
single-responsibility tasks with blocking edges. It does **not** restate the spec; it
references the authoritative documents and adds only what they omit.

## Goal

Replace the [`services/signer-service`](services/signer-service/src/app.ts) stub with the real
KMS-backed signer: derive the paying address from the KMS public key, build EIP-3009 typed data,
sign, normalise the KMS signature, enforce the seven hard-invariant rail refusals, and prove
network isolation — all testable offline behind the `KeySource` seam.

## Source of truth (read first, in order)

1. [`/tmp/straitsx-888-handoff.md`](file:///tmp/straitsx-888-handoff.md) — current state + working agreements + corrections.
2. [`docs/owner-a-tasks.md`](docs/owner-a-tasks.md) — Phase 3 = A11–A16, Phase 4 = A17/A18.
3. [`docs/api-contracts.md`](docs/api-contracts.md) §0, §4 — wire shapes, error envelope, the seven refusals.
4. [`docs/execution_plan.md`](docs/execution_plan.md) §9, §11, §12b 2.2, §19 — EIP-712 sources, isolation, rail, resolved facts.
5. [`~/.claude/plans/calm-knitting-melody.md`](file:///Users/vindyanggiono/.claude/plans/calm-knitting-melody.md) — the approved plan.

## Working agreements — these override every skill instruction

- **NEVER run `git commit`.** Write the commit message as a copy-pasteable block; the human runs it.
- **Commit commands must avoid shell-special characters** (no backticks, `$`, `!`, apostrophes).
- **Follow approved phase order.** Phase 3 is next; do not jump phases.
- **Lead with the _why_** before any diff.

## Architecture — the `KeySource` seam

```ts
interface KeySource {
  getPublicKeyDer(): Promise<Uint8Array>; // SPKI DER
  signDigest(digest: Uint8Array): Promise<Uint8Array>; // ECDSA DER
}
```

`KmsKeySource` (real AWS) and `LocalKeySource` (dev/test, emulates KMS's DER output) feed the
**identical** parse → normalise → recover path. This makes A13 fully testable offline and the KMS
swap changes no logic. `@aws-sdk/client-kms`, `@noble/curves`, and `viem` are already declared in
[`services/signer-service/package.json`](services/signer-service/package.json).

## Module map (new files, under `services/signer-service/src/`)

| Module                               | Responsibility                                                       |
| ------------------------------------ | -------------------------------------------------------------------- |
| `keys/key-source.ts`                 | `KeySource` interface                                                |
| `keys/local-key-source.ts`           | `LocalKeySource` — private key → SPKI DER pubkey, digest → ECDSA DER |
| `keys/der.ts`                        | ECDSA DER decode/encode + `normaliseS` (lower half of curve order)   |
| `keys/derive-address.ts`             | SPKI DER public key → checksummed Ethereum address                   |
| `keys/kms-key-source.ts`             | `KmsKeySource` — AWS `GetPublicKey`/`Sign` wrapper                   |
| `sign/typed-data.ts`                 | Build `TransferWithAuthorization` typed data + EIP-712 digest        |
| `sign/pipeline.ts`                   | parse → normalise → recover `v` → `{ v, r, s }` + base64 header      |
| `sign/rail.ts`                       | Seven pure refusal checks + pinned-map load + replay set             |
| `routes/health.ts`, `routes/sign.ts` | Fastify routes (replaces inline handlers in `app.ts`)                |

## Task queue

The blocking edges live in [`queue_tasks.jsonl`](queue_tasks.jsonl). Summary (T1→T18, dependency
order):

- **T1** `KeySource` seam + `LocalKeySource`
- **T2** DER codec + `s`-normalisation
- **T3** SPKI DER → address derivation
- **T4** EIP-712 typed data + digest (A12)
- **T5** sign pipeline — parse→normalise→recover→header (A13)
- **T6** `KmsKeySource` (AWS SDK wrapper)
- **T7** seven-refusal rail (A14)
- **T8** signer app rewrite — `/health` + `/sign`, replaces the stub
- **T9** three offline signature vectors (A13 TDD deliverable)
- **T10** seven-refusal unit tests (A14)
- **T11** `main.ts` rewrite — boot address assertion + key-source selection
- **T12** `scripts/setup-kms.sh` + `scripts/move-xsgd.ts` (A11 custody)
- **T13** A15 docker-compose + isolation probe (`scripts/test-isolation.sh`)
- **T14** A16 checkpoint-2 probe + latency measurement
- **T15** A18 production 402 probe script
- **T16** update the three docs to replace `0x9f6B…1bF7` with `EXPECTED_SIGNER_ADDRESS`
- **T17** A17 nonce decision (decision-only, no code)
- **T18** verification + code-review + commit-message block

## Human-blocked (build now, exercise later)

| Task        | Blocked on                                                          | Note                                   |
| ----------- | ------------------------------------------------------------------- | -------------------------------------- |
| T6 exercise | AWS account + `aws` CLI + IAM `kms:CreateKey`/`GetPublicKey`/`Sign` | none exist on this machine             |
| T12 run     | KMS key + the `0x9f6B…1bF7` wallet to move 30 XSGD                  | Fuji first, mainnet after Fuji lands   |
| T14 run     | KMS key + funded `EXPECTED_SIGNER_ADDRESS`                          | nothing external blocks the _code_     |
| T15 run     | organiser clearance for `/production/sse`                           | permission, not engineering            |
| T17         | human decision                                                      | recommend the commitment nonce variant |

## Open details to verify during implementation

1. **Exact `PAYMENT-SIGNATURE` payload schema.** The header is base64 and the field name is
   `PAYMENT-SIGNATURE` per [`docs/api-contracts.md`](docs/api-contracts.md) §4, but the precise
   JSON structure inside the base64 must be confirmed against the x402 spec before A16. The stub
   header (`{stub:true,…}`) is deliberately fake and does **not** document the real schema. Do
   not guess it; the first real signature (T14) is the ultimate validator.
2. **SPKI parsing.** `GetPublicKey` returns X.509 SubjectPublicKeyInfo; extract the trailing
   uncompressed point (`04‖x‖y`) with a minimal ASN.1 read — do not assume a fixed 65-byte tail.
3. **`v` recovery** is by trying both parities against `derivedAddress` — KMS returns no
   recovery id.

## Verification & review

- `pnpm typecheck` after **every** task that adds source _or_ tests (the handoff records a stale
  typecheck as a prior false "pass").
- Full suite once at the end: `export PATH="$HOME/.foundry/bin:$PATH"; pnpm typecheck && LIVE_RPC=1 pnpm test && (cd packages/contracts-sol && forge test)`.
- Code-review against fixed point `3fac64e` (NOT `5851eb3` — that pulls Owner B's ~2,900 lines
  into the diff).
- Re-run the numbers; do not trust the handoff's 145/151.
