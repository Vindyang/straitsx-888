# Intent commitment nonce design

Date: 2026-08-16

## Scope

Switch policy-service from a random EIP-3009 nonce to the commitment strategy already
selected in `docs/execution_plan.md`:

```text
nonce = keccak256(requestIdHash || policyHash || intentHash || merchantDomainHash)
```

This slice defines the previously-undefined `intentHash`, carries it across the existing
ledger and policy boundaries, and makes the receipt independently recomputable. It does not
change signer-service policy, EIP-3009 encoding, nonce reservation semantics, escalation
matching, or merchant discovery.

## Canonical intent hash

`intentHash` is exactly:

```ts
keccak256(toBytes(verbatimHumanInstruction))
```

The instruction is encoded as UTF-8 exactly as received by `POST /intent`. There is no
trimming, Unicode normalization, case folding, JSON wrapping, or inclusion of mutable
metadata. This makes different byte sequences different intents and avoids serialization
drift between services.

The full instruction remains stored for display and auditing. The hash is a fixed 32-byte
hex value used for integrity and commitment only.

## Ownership and interfaces

The shared contracts package owns the sole `hashIntentInstruction(instruction)`
implementation. Ledger-service calls it when creating the immutable intent and stores the
result as `instructionHash`. Policy-service obtains that stored value through
`GET /intent/:requestId`; it never trusts or re-hashes the duplicate `intent` field on the
payment request.

`performSigning` receives a commitment input containing:

- `policyHash`, computed with the existing shared `hashPolicy`;
- `intentHash`, read from the immutable ledger record;
- `merchantDomain`, taken from the resolved item that passed the policy pipeline.

It calls the existing shared `buildCommitmentNonce` and reserves the resulting nonce before
calling signer-service. Signer-service remains unchanged and treats the nonce as opaque
`bytes32`.

## Data flow

1. Module C creates an intent with the verbatim human instruction.
2. Ledger stores the instruction and canonical `instructionHash` atomically.
3. Module C discovers the merchant and sends `resolvedItem.merchantDomain` with the payment
   request.
4. Policy loads the immutable intent and policy, runs checks 1-9, and computes the commitment
   nonce from ledger-backed and policy-validated inputs.
5. Ledger conditionally reserves that nonce; signer signs it unchanged.
6. Ledger receipt exposes `instructionHash` as `intentHash` alongside the other commitment
   inputs and the signed nonce.
7. A verifier recomputes `buildCommitmentNonce` from the receipt and compares it with the
   authorization nonce in the settled transfer.

## Missing merchant domain

A signed result requires `resolvedItem.merchantDomain`. If it is absent or empty,
policy-service refuses before nonce reservation. It must not substitute the StraitsX card API
hostname or an empty string because either would create a valid but semantically false
commitment.

Budget escalations preserve the validated merchant domain in the escalation record so an
approval resumes with the same commitment inputs. A resumed escalation refuses if that
domain is unavailable.

## Replay and failure behavior

Existing rules remain unchanged:

- A second reservation for the same active intent fails.
- A pre-signature signer failure may release the reservation.
- After signer-service returns a signature, the nonce is burned and the intent is terminal.
- A post-signature retry requires a fresh request ID, which produces a different commitment.

Because the commitment is deterministic, retrying the same request before a signature
recomputes the same nonce. Reservation state, not randomness, remains the concurrency and
replay boundary.

## Public test seams

Tests cover behavior through these approved seams:

1. Shared contract: `hashIntentInstruction` returns a known 32-byte Keccak vector and is
   byte-sensitive.
2. Ledger HTTP API: `POST /intent` and `GET /intent/:requestId` expose the canonical hash;
   receipts expose the same value as `intentHash`.
3. Policy HTTP API: a successful `POST /payment/request` reserves and returns the exact
   commitment nonce computed from ledger-backed inputs; changing any commitment input changes
   the nonce.
4. Policy refusal: a missing merchant domain fails before reserve/sign calls.
5. Escalation resume: approval uses the same stored intent hash and merchant domain rather
   than request-supplied replacements.

Existing reservation, release, signer-rail, and x402 header tests remain unchanged and must
stay green.

## Acceptance criteria

- No production path imports or calls `randomBytes` for nonce generation.
- Every stored intent hash is a lowercase `0x`-prefixed 32-byte Keccak hash.
- Policy computes commitment inputs only from immutable ledger data and validated policy
  context.
- Receipts contain enough non-secret information to recompute the nonce.
- TypeScript typecheck, Vitest, and Foundry suites pass.
