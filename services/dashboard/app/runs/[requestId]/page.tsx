"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { connectWallet } from "../../../lib/wallet";

type RunOutcome =
  | { status: "refused"; check: string; checkIndex: number | null; detail: string; humanExplanation: string }
  | { status: "escalated"; reason: string; approvalUrl: string; expiresAt: number; ttlSeconds: number }
  | { status: "signed"; settlementTx: string | null; cardOpaqueId: string | null }
  | { status: "failed"; message: string };

type RunRecord = {
  requestId: string;
  meta: { instruction: string; mandateId: string; fixture: string; productUrl: string };
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

  async function respond(decision: "approve" | "deny") {
    setError(null);
    setBusy(true);
    try {
      const approvedBy = await connectWallet();
      const res = await fetch(`/api/approve/${requestId}`, {
        method: "POST",
        body: JSON.stringify({ decision, approvedBy }),
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
        {run.meta.instruction} — fixture: {run.meta.fixture}
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
              <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.85em" }}>
                {JSON.stringify(run.resolvedItem, null, 2)}
              </pre>
            </div>
            <div>
              <h3>Independently re-fetched (the real control)</h3>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.85em" }}>
                {independent ? JSON.stringify(independent.independentlyFetched, null, 2) : "loading…"}
              </pre>
            </div>
          </div>

          {error && <p style={{ color: "crimson" }}>{error}</p>}
          <button type="button" onClick={() => respond("approve")} disabled={busy} style={{ marginRight: 8 }}>
            Approve
          </button>
          <button type="button" onClick={() => respond("deny")} disabled={busy}>
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
