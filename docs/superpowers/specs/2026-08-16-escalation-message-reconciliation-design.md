# Escalation message reconciliation design

Date: 2026-08-16

## Scope

Merge `origin/module-c` into the current `module-a` working branch without creating a commit,
then reconcile the dashboard's EIP-191 escalation signature with the canonical message that
policy-service verifies.

This slice changes only escalation-message construction and the integration artifacts needed
to merge the branches safely. It does not change escalation authorization rules, expiry
handling, standing-approval semantics, mandate ownership, or the orchestrator's run lifecycle.

## Canonical signed message

The shared contracts package remains the sole owner of the signed message:

```text
straitsx-888 escalation decision
requestId: <requestId>
mandateId: <mandateId>
decision: approve|deny
```

Both the dashboard and policy-service import `buildEscalationMessage` from
`@straitsx/contracts`. No service or UI duplicates the literal, capitalization, field order,
or newline layout.

The message binds the decision to both the request and its mandate. `expiresAt` remains an
enforced server-side escalation property but is not part of the signed message: policy-service
loads the stored escalation, rejects it after its stored expiry, and never trusts an expiry
supplied by the dashboard.

## Data flow

1. The dashboard loads the run record, including `run.meta.mandateId`.
2. The human chooses `approve` or `deny`.
3. The dashboard calls `signEscalationDecision(requestId, mandateId, decision)`.
4. The wallet helper builds the message with the shared `buildEscalationMessage` function and
   asks the injected wallet to `personal_sign` it.
5. The dashboard sends only `decision`, `approvedBy`, `signature`, and optional standing-
   approval scope through its API route to agent-orchestrator.
6. Agent-orchestrator forwards those fields unchanged to policy-service.
7. Policy-service loads the stored escalation and mandate, rebuilds the same shared message,
   verifies the signature against `mandate.owner`, then applies approve or deny behavior.

The dashboard never sends `mandateId` or `expiresAt` as authoritative resolve inputs. They are
display/signing context only; policy-service obtains authoritative values from storage.

## Merge handling

The branch merge uses `git merge --no-commit --no-ff origin/module-c`. Existing Module A/B
changes and Module C additions are both retained.

Expected conflicts are resolved as follows:

- `.dockerignore`: retain all secret/build exclusions and all service-specific context rules;
- `.env.example`: retain A/B configuration and add C's orchestrator/dashboard variables;
- `README.md`, `docs/api-contracts.md`, and `docs/conventions.md`: combine the two modules'
  truthful behavior, replacing the stale Module C escalation-message description;
- `pnpm-lock.yaml`: resolve through the merged workspace manifests and regenerate with the
  repository's pinned pnpm version rather than hand-editing dependency entries.

No merge commit or feature commit is created. The integrated worktree remains available for
review and for the user to commit later.

## Error and security behavior

- If a run lacks `meta.mandateId`, the dashboard does not request a signature and reports an
  error to the human.
- Missing `approvedBy` or `signature` remains a `400` at agent-orchestrator.
- A signer other than `mandate.owner`, or a signature for another request, mandate, or
  decision, remains a `403` at policy-service.
- Expired escalations remain terminally denied before signature approval can resume signing.
- Policy-service does not accept the legacy Module C message and does not implement a dual-
  format compatibility or downgrade path.

## Public test seams

Tests cover behavior only through these agreed interfaces:

1. Dashboard wallet helper: an injected EIP-1193 provider receives `personal_sign` with a
   known canonical message containing request ID, mandate ID, and decision, plus the connected
   account.
2. Policy HTTP API: `POST /escalation/:requestId/resolve` accepts a valid owner signature over
   the canonical message and rejects signatures whose request ID, mandate ID, or decision was
   altered.
3. Agent-orchestrator escalation route/pipeline: `approvedBy` and `signature` are forwarded
   unchanged while the same pending run resumes or terminates.

Expected strings in tests are fixed literals from this specification, not values recomputed
with the production builder.

## Acceptance criteria

- `origin/module-c` is integrated into the working tree with no unresolved merge markers.
- Dashboard production code contains no hand-written escalation-message format.
- Dashboard and policy-service use the same shared `buildEscalationMessage` implementation.
- Correct owner approvals and denials work end to end at the local service boundaries.
- Altered request ID, mandate ID, or decision signatures fail closed.
- TypeScript typecheck, the full Vitest suite, dashboard build, and Foundry tests pass.
- Git history is unchanged by this task; a suggested commit message is reported instead.
