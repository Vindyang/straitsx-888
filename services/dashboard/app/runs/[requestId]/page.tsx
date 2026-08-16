"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { signEscalationDecision } from "../../../lib/wallet";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import { Button, buttonVariants } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import { PageHeading } from "../../../components/page-heading";

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
      const { approvedBy, signature } = await signEscalationDecision(requestId, run.meta.mandateId, decision);
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
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const outcome = run.outcome;

  return (
    <div className="flex flex-col gap-8">
      <PageHeading
        backHref="/runs"
        title={`Run ${requestId.slice(0, 8)}`}
        description={`${run.meta.instruction} — source: ${run.meta.fixture ?? run.meta.source?.profileId ?? run.meta.source?.name}`}
      />

      {outcome?.status === "refused" && (
        <Card className="border-destructive/60 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-sm font-semibold uppercase tracking-wide text-destructive">
              Refused — check {outcome.checkIndex ?? "?"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <h2 className="text-2xl font-semibold tracking-tight">{outcome.check}</h2>
            <p className="text-lg">{outcome.humanExplanation}</p>
            <pre className="whitespace-pre-wrap rounded-md bg-background p-4 text-sm">{outcome.detail}</pre>
            <p className="text-lg font-bold text-destructive">Nothing was signed. No money moved.</p>
          </CardContent>
        </Card>
      )}

      {outcome?.status === "escalated" && (
        <Card className="border-amber-600/60 bg-amber-600/5">
          <CardHeader>
            <CardTitle>Escalated — human decision required</CardTitle>
            <CardDescription>reason: {outcome.reason}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <CountdownTtl expiresAt={outcome.expiresAt} />

            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Agent&apos;s self-report (not ground truth)</CardTitle>
                </CardHeader>
                <CardContent>
                  <ComparisonData data={run.resolvedItem ?? {}} other={independent?.independentlyFetched} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Independently re-fetched (the real control)</CardTitle>
                </CardHeader>
                <CardContent>
                  {independent ? (
                    <ComparisonData data={independent.independentlyFetched} other={run.resolvedItem} />
                  ) : (
                    <p className="text-sm text-muted-foreground">loading…</p>
                  )}
                </CardContent>
              </Card>
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertTitle>Escalation failed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => respond("approve")} disabled={busy || isExpired(outcome.expiresAt)}>
                Approve once
              </Button>
              <Button type="button" variant="outline" onClick={() => respond("approve", true)} disabled={busy || isExpired(outcome.expiresAt)}>
                Approve merchant for this window
              </Button>
              <Button type="button" variant="destructive" onClick={() => respond("deny")} disabled={busy || isExpired(outcome.expiresAt)}>
                Deny
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {outcome?.status === "signed" && (
        <Card className="border-green-600/60 bg-green-600/5">
          <CardContent className="flex items-center justify-between gap-4 py-6">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-green-700">Signed and settled</h2>
              <p className="text-sm text-muted-foreground">The settlement was signed by the mandate signer.</p>
            </div>
            <Link
              href={`/receipt/${requestId}`}
              className={buttonVariants({ variant: "default" })}
            >
              View receipt →
            </Link>
          </CardContent>
        </Card>
      )}

      {(outcome?.status === "checkout-pending" || run.state === "AWAITING_CHECKOUT") && (
        <Card className="border-sky-600/60 bg-sky-600/5">
          <CardContent className="py-6">
            <h2 className="text-xl font-semibold tracking-tight text-sky-700">Settlement verified — checkout in progress</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The one-time card view exists only inside the isolated browser context.
            </p>
          </CardContent>
        </Card>
      )}

      {outcome?.status === "failed" && (
        <Card>
          <CardHeader>
            <CardTitle>Failed</CardTitle>
            <CardDescription>{outcome.message}</CardDescription>
          </CardHeader>
        </Card>
      )}

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold tracking-tight">Event timeline</h2>
        <Card>
          <CardContent className="py-6">
            <ol className="space-y-1 text-sm">
              {run.events.map((event) => (
                <li key={event.seq}>
                  {event.stage}
                  {event.status ? ` — ${event.status}` : ""}
                  {event.check ? ` (${event.check})` : ""}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function isExpired(expiresAt: number): boolean { return Math.floor(Date.now() / 1000) >= expiresAt; }

function ComparisonData({ data, other }: { data: Record<string, unknown>; other?: Record<string, unknown> }) {
  return (
    <dl className="space-y-1 text-sm">
      {Object.entries(data).map(([key, value]) => {
        const mismatch = other && key in other && String(other[key]) !== String(value);
        return (
          <div key={key} className={`rounded px-2 py-1 ${mismatch ? "bg-destructive/10" : ""}`}>
            <dt className="font-semibold">{key}{mismatch ? " — mismatch" : ""}</dt>
            <dd className="ml-0 text-muted-foreground">{String(value)}</dd>
          </div>
        );
      })}
    </dl>
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
    <p className={`font-semibold ${remaining === 0 ? "text-red-600" : "text-amber-700"}`}>
      {remaining === 0 ? "Expired — auto-denied" : `${remaining}s remaining (expiry means deny)`}
    </p>
  );
}