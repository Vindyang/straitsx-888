# Module split — three people, three files

`../Straitsx.drawio` stays the master (Architecture / Decision flow / Sequence). It is the
shared picture and should change rarely. These three files are the working copies — one per
person, so nobody edits the same XML at the same time.

| File | Owner | Services |
| --- | --- | --- |
| [module-a-custody-and-chain.drawio](module-a-custody-and-chain.drawio) | A | `mandate-registry`, `chain-gateway`, `signer-service` |
| [module-b-decision-and-record.drawio](module-b-decision-and-record.drawio) | B | `policy-service`, `ledger-service` |
| [module-c-agent-and-surfaces.drawio](module-c-agent-and-surfaces.drawio) | C | `agent-orchestrator`, `card-gateway`, `dashboard` |

The split follows the ownership table in `docs/execution_plan.md` §4 — it is the seam the
plan already assumes, not a new one. Each file shows what you build in colour, what you stub
in grey, the invariants you may not soften, your numbered slice of the pipeline, and a
definition of done. Module B carries a verbatim copy of the master's **Decision flow** page,
because that ladder *is* Module B's spec.

## The seams

Everything crossing a module boundary. These are the only things you must agree on; behind
them each person is free.

**A publishes** (B and C are blocked until these are frozen)

```
mandate-registry   deployed address + ABI          — within two hours, per §6
chain-gateway      getMandate · getTokenConstants · confirmSettlement · buildRevokeTx · buildCreateMandate
signer-service     sign(typedData, requestId) -> { header, nonce }
```

**B publishes** (C is blocked until frozen)

```
policy-service     POST /payment/request
                     body     { requestId, mandateId, intent, resolvedItem, challenge }
                     response { signed, header, nonce } | { refused, check, detail } | { escalated, approvalUrl }
ledger-service     createIntent · getIntent · attachChallenge · reserveNonce · releaseNonce
                   getWindowUsage · recordDecision · recordSpend · getPolicy · putPolicy
```

**C publishes**

```
card-gateway       getCard({ walletAddress, cardholderName, amountSgd }) -> { cardapiUrl, challenge }
                   viewCard({ cardOpaqueId, settlementTx, walletAddress }) -> iframeUrl
```

**Shared by everyone — owned by nobody alone**

`hashPolicy()` and the canonical policy serialisation live in one shared package. The
dashboard computes `policyHash` at mandate creation and policy-service recomputes it at
check 2. If the two serialisations ever diverge, every mandate fails check 2. Nobody
reimplements it locally.

## Rules that span modules

Two constraints are only true if more than one person keeps them, so they appear in more
than one file:

1. **`signer-service` accepts calls from `policy-service` and nothing else** — enforced at
   the network layer and proven by A's probe test. If C can reach the signer, the whole
   security claim collapses.
2. **Settlement precedes issuance and is irreversible.** After the cardapi retry there is no
   release and no rollback: B must treat the intent as terminal once a signature exists, and
   C must not retry around a refusal.

## Suggested order

Day one: A deploys the registry and publishes the ABI; B and C stub every dependency and
build against the stubs. Integrate A→B before B→C — the decision path is the risky join, and
C's surfaces degrade gracefully while it settles.

## Keeping the files honest

If you change an interface, change it in the master **and** in the two module files that
sit on either side of the seam. If you change only your own file, the split has started to
lie.
