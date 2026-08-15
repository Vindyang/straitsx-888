"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { signEscalationDecision } from "../../../lib/wallet";

type RunOutcome =
  | { status: "refused"; check: string; checkIndex: number | null; detail: string; humanExplanation: string }
  | { status: "escalated"; reason: string; approvalUrl: string; expiresAt: number; ttlSeconds: number }
  | { status: "checkout-pending"; settlementTx: string; cardOpaqueId: string }
  | { status: "signed"; settlementTx: string | null; cardOpaqueId: string | null }
  | { status: "failed"; message: string };

type RunRecord = {
  requestId: string;
  meta: { instruction: string; mandateId: string; fixture?: string; source?: { kind: string; name?: string; profileId?: string }; productUrl: string };
  state: string;
  events: Array<{ seq: number; stage: string; status?: string; check?: string; at: string }>;
  resolvedItem?: { title: string; sku: string; price: string; merchantDomain: string; checkoutUrl: string };
  outcome?: RunOutcome;
};

type IndependentCheck = { independentlyFetched: { title?: string; sku?: string; price?: string } };

/**
 * C12 — the refusal panel: the most important screen in the project. Also
 * hosts C15's escalation approval screen when the outcome is "escalated".
 */
export default function RunDetailPage() {
  const params = useParams<{ requestId: string }>();
  const requestId = params.requestId;
  const [run, setRun] = useState<RunRecord | null>(null);
  const [independent, setIndependent] = useState<IndependentCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetch(`/api/runs/${requestId}`, { cache: "no-store" })
        .then((res) => (res.ok ? (res.json() as Promise<RunRecord>) : null))
        .then(setRun);
    void load();
    const interval = setInterval(load, 2000);
    return () => clearInterval(interval);
  }, [requestId]);

  useEffect(() => {
    if (run?.outcome?.status !== "escalated") return;
    fetch(`/api/runs/${requestId}/independent-check`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<IndependentCheck>) : null))
      .then(setIndependent);
  }, [run?.outcome?.status, requestId]);

  async function respond(decision: "approve" | "deny", standing = false) {
    if (run?.outcome?.status !== "escalated") return;
    setError(null);
    setBusy(true);
    try {
      const { approvedBy, signature } = await signEscalationDecision(requestId, decision, run.outcome.expiresAt);
      const res = await fetch(`/api/run/${requestId}/escalation`, {
        method: "POST",
        body: JSON.stringify({ decision, approvedBy, signature, ...(standing ? { standingApproval: { scope: "merchant-window" } } : {}) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `failed to ${decision}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!run) {
    return (
      <main style={{ maxWidth: 800, margin: "0 auto", padding: "2rem" }}>
        <p>Loading…</p>
      </main>
    );
  }

  const outcome = run.outcome;

  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: "2rem" }}>
      <p>
        <Link href="/runs">&larr; all runs</Link>
      </p>
      <h1>Run {requestId.slice(0, 8)}</h1>
      <p style={{ color: "#666" }}>
        {run.meta.instruction} — source: {run.meta.fixture ?? run.meta.source?.profileId ?? run.meta.source?.name}
      </p>

      {outcome?.status === "refused" && (
        <section style={{ background: "#fff2f2", border: "3px solid crimson", borderRadius: 12, padding: "2rem", marginTop: "1.5rem" }}>
          <p style={{ fontSize: "0.9em", letterSpacing: 1, textTransform: "uppercase", color: "crimson", margin: 0 }}>
            Refused — check {outcome.checkIndex ?? "?"}
          </p>
          <h2 style={{ margin: "0.25rem 0 1rem", fontSize: "2rem" }}>{outcome.check}</h2>
          <p style={{ fontSize: "1.2rem" }}>{outcome.humanExplanation}</p>
          <pre style={{ whiteSpace: "pre-wrap", background: "#fff", padding: "1rem", borderRadius: 8 }}>{outcome.detail}</pre>
          <p style={{ fontWeight: 700, fontSize: "1.3rem", color: "crimson", margin: 0 }}>
            Nothing was signed. No money moved.
          </p>
        </section>
      )}

      {outcome?.status === "escalated" && (
        <section style={{ border: "3px solid #a60", borderRadius: 12, padding: "2rem", marginTop: "1.5rem" }}>
          <h2 style={{ marginTop: 0 }}>Escalated — human decision required</h2>
          <p>reason: {outcome.reason}</p>
          <CountdownTtl expiresAt={outcome.expiresAt} />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginTop: "1rem" }}>
            <div>
              <h3>Agent&apos;s self-report (not ground truth)</h3>
              <ComparisonData data={run.resolvedItem ?? {}} other={independent?.independentlyFetched} />
            </div>
            <div>
              <h3>Independently re-fetched (the real control)</h3>
              {independent ? <ComparisonData data={independent.independentlyFetched} other={run.resolvedItem} /> : "loading…"}
            </div>
          </div>

          {error && <p style={{ color: "crimson" }}>{error}</p>}
          <button type="button" onClick={() => respond("approve")} disabled={busy || isExpired(outcome.expiresAt)} style={{ marginRight: 8 }}>
            Approve once
          </button>
          <button type="button" onClick={() => respond("approve", true)} disabled={busy || isExpired(outcome.expiresAt)} style={{ marginRight: 8 }}>
            Approve merchant for this window
          </button>
          <button type="button" onClick={() => respond("deny")} disabled={busy || isExpired(outcome.expiresAt)}>
            Deny
          </button>
        </section>
      )}

      {outcome?.status === "signed" && (
        <section style={{ border: "2px solid green", borderRadius: 12, padding: "1.5rem", marginTop: "1.5rem" }}>
          <h2 style={{ marginTop: 0, color: "green" }}>Signed and settled</h2>
          <p>
            <Link href={`/receipt/${requestId}`}>View receipt →</Link>
          </p>
        </section>
      )}

      {(outcome?.status === "checkout-pending" || run.state === "AWAITING_CHECKOUT") && (
        <section style={{ border: "2px solid #075985", borderRadius: 12, padding: "1.5rem", marginTop: "1.5rem" }}>
          <h2 style={{ marginTop: 0 }}>Settlement verified — checkout in progress</h2>
          <p>The one-time card view exists only inside the isolated browser context.</p>
        </section>
      )}

      {outcome?.status === "failed" && (
        <section style={{ border: "2px solid #888", borderRadius: 12, padding: "1.5rem", marginTop: "1.5rem" }}>
          <h2 style={{ marginTop: 0 }}>Failed</h2>
          <p>{outcome.message}</p>
        </section>
      )}

      <h3 style={{ marginTop: "2rem" }}>Event timeline</h3>
      <ol>
        {run.events.map((event) => (
          <li key={event.seq}>
            {event.stage}
            {event.status ? ` — ${event.status}` : ""}
            {event.check ? ` (${event.check})` : ""}
          </li>
        ))}
      </ol>
    </main>
  );
}

function isExpired(expiresAt: number): boolean { return Math.floor(Date.now() / 1000) >= expiresAt; }

function ComparisonData({ data, other }: { data: Record<string, unknown>; other?: Record<string, unknown> }) {
  return <dl>{Object.entries(data).map(([key, value]) => {
    const mismatch = other && key in other && String(other[key]) !== String(value);
    return <div key={key} style={{ background: mismatch ? "#fff2f2" : "transparent", padding: 4 }}>
      <dt style={{ fontWeight: 700 }}>{key}{mismatch ? " — mismatch" : ""}</dt><dd style={{ marginLeft: 0 }}>{String(value)}</dd>
    </div>;
  })}</dl>;
}

/** TTL + auto-deny (execution_plan.md §12b 2.1): expiry means DENY, never hang. */
function CountdownTtl({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(interval);
  }, []);
  const remaining = Math.max(0, expiresAt - now);
  return (
    <p style={{ fontWeight: 600, color: remaining === 0 ? "crimson" : "#a60" }}>
      {remaining === 0 ? "Expired — auto-denied" : `${remaining}s remaining (expiry means deny)`}
    </p>
  );
}
