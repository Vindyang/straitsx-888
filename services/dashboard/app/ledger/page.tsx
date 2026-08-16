"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { PageHeading } from "../../components/page-heading";

type IntentView = {
  requestId: string;
  mandateId: string;
  agentId: string;
  instruction: string;
  instructionHash: string;
  createdAt: string;
  state: "INTENT_CREATED" | "CHALLENGE_ATTACHED" | "NONCE_RESERVED" | "SIGNED" | "SETTLED" | "CAPTURED";
  decision?: "signed" | "refused" | "escalated";
  decidedAt?: string;
  check?: string;
  detail?: string;
  policyHash?: string;
  merchantDomain?: string;
  challenge?: { payTo: string; asset: string; chainId: number; amount: string };
  nonce?: string;
  nonceReserved?: boolean;
  settlement?: { settlementTx: string; blockNumber: number; cardOpaqueId: string };
  spend?: { merchantDomain: string; orderTotal: string; itemSku: string; orderId: string; observedAt: string };
  capture?: { orderId: string; capturedAt: string; settlementTx: string; blockNumber: number };
};

type LedgerAppendEvent = {
  seq: number;
  kind: string;
  at: string;
  requestId?: string;
  mandateId?: string;
  state?: string;
  intent?: IntentView;
  detail?: Record<string, unknown>;
};

const STATE_BADGE: Record<string, string> = {
  INTENT_CREATED: "bg-muted text-muted-foreground",
  CHALLENGE_ATTACHED: "bg-sky-600/15 text-sky-700",
  NONCE_RESERVED: "bg-sky-600/15 text-sky-700",
  SIGNED: "bg-indigo-600/15 text-indigo-700",
  SETTLED: "bg-amber-600/15 text-amber-700",
  CAPTURED: "bg-green-600/15 text-green-700",
};

const DECISION_BADGE: Record<string, string> = {
  signed: "bg-green-600/15 text-green-700",
  refused: "bg-red-600/15 text-red-700",
  escalated: "bg-amber-600/15 text-amber-700",
};

const short = (value: string | undefined, head = 10, tail = 6) =>
  value ? (value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value) : "-";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="font-mono text-xs text-foreground">{children}</span>
    </div>
  );
}

export default function LedgerPage() {
  const [intents, setIntents] = useState<IntentView[]>([]);
  const [events, setEvents] = useState<LedgerAppendEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  const upsertIntent = (view: IntentView) =>
    setIntents((prev) => [view, ...prev.filter((it) => it.requestId !== view.requestId)]);

  useEffect(() => {
    fetch("/api/ledger", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`snapshot ${res.status}`);
        const body = (await res.json()) as { intents: IntentView[] };
        setIntents(body.intents);
      })
      .catch((error: Error) => setSnapshotError(error.message));

    const source = new EventSource("/api/ledger/events");
    source.addEventListener("snapshot", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { intents: IntentView[] };
      setIntents(data.intents);
      setEvents([]);
      setConnected(true);
    });
    source.addEventListener("append", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as LedgerAppendEvent;
      setEvents((prev) => [data, ...prev].slice(0, 200));
      if (data.intent) upsertIntent(data.intent);
      setConnected(true);
    });
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-start justify-between gap-4">
        <PageHeading
          title="Ledger"
          description="The append-only record behind every mandate. Each payment step is broadcast here as it happens — refusals included."
        />
        <span className="mt-2 flex shrink-0 items-center gap-2 text-xs font-medium text-muted-foreground" aria-live="polite">
          <span className={`size-2 rounded-full ${connected ? "animate-pulse bg-green-600" : "bg-red-600"}`} />
          {connected ? "live" : "stream disconnected"}
        </span>
      </div>

      {snapshotError && (
        <p className="text-sm text-amber-700">
          Ledger snapshot unavailable: {snapshotError}
        </p>
      )}

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="flex flex-col gap-4">
          {intents.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No intents recorded yet — run a payment from the home page and watch it appear here.
            </p>
          )}
          {intents.map((intent) => (
            <Card key={intent.requestId}>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <CardTitle className="font-mono text-sm">{intent.requestId}</CardTitle>
                  <span className="flex items-center gap-2">
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATE_BADGE[intent.state] ?? "bg-muted"}`}>
                      {intent.state}
                    </span>
                    {intent.decision && (
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${DECISION_BADGE[intent.decision]}`}>
                        {intent.decision}
                      </span>
                    )}
                  </span>
                </div>
                <CardDescription className="text-foreground">
                  {intent.instruction}
                  {intent.check && (
                    <span className="mt-1 block text-xs text-red-700">
                      {intent.check} — {intent.detail}
                    </span>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <Row label="mandate">{short(intent.mandateId)}</Row>
                  <Row label="agent">{short(intent.agentId)}</Row>
                  <Row label="policy hash">{short(intent.policyHash)}</Row>
                  <Row label="merchant">{short(intent.merchantDomain)}</Row>
                </div>
                <div>
                  <Row label="pay to">{short(intent.challenge?.payTo)}</Row>
                  <Row label="amount">{intent.challenge?.amount ? `${intent.challenge.amount} base units` : "-"}</Row>
                  <Row label="chain">{intent.challenge?.chainId ?? "-"}</Row>
                  <Row label="nonce">{short(intent.nonce, 8, 6)}</Row>
                </div>
                <div>
                  <Row label="settlement tx">{short(intent.settlement?.settlementTx)}</Row>
                  <Row label="block">{intent.settlement?.blockNumber ?? "-"}</Row>
                  <Row label="order">{short(intent.spend?.orderId ?? intent.capture?.orderId)}</Row>
                  <Row label="instructions hash">{short(intent.instructionHash, 8, 6)}</Row>
                </div>
              </CardContent>
            </Card>
          ))}
        </section>

        <aside>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Live events</CardTitle>
              <CardDescription>Every ledger mutation, broadcast as it happens.</CardDescription>
            </CardHeader>
            <CardContent className="flex max-h-[70vh] flex-col gap-1 overflow-y-auto font-mono text-xs">
              {events.length === 0 && <p className="text-muted-foreground">Waiting for the next mutation…</p>}
              {events.map((event) => (
                <div key={event.seq} className="flex justify-between gap-3 border-b py-1.5 last:border-0">
                  <span className="truncate text-muted-foreground">
                    <span className="text-foreground">#{event.seq}</span> {event.kind}
                    {event.requestId ? ` · ${short(event.requestId, 6, 4)}` : ""}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{event.at.slice(11, 19)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}