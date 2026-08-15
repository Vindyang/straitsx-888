"use client";

import { useEffect, useState } from "react";

type RunEvent = { seq: number; stage: string; status?: string; check?: string; at: string };

const FIXTURES = ["clean", "poisoned-recipient", "poisoned-amount", "wrong-item"] as const;
type Fixture = (typeof FIXTURES)[number];

/**
 * C1 — the dashboard scaffold: one page, drives agent-orchestrator through
 * server-route proxies. Mandate creation, the refusal panel, receipt view and
 * the spend meter (C11-C15) are a separate build phase and are not here.
 */
export default function Page() {
  const [mandateId, setMandateId] = useState("0x7f3a");
  const [agentId, setAgentId] = useState("shopper-1");
  const [instruction, setInstruction] = useState(
    "Buy the 500ml stainless water bottle from localhost, under S$20",
  );
  const [fixture, setFixture] = useState<Fixture>("clean");
  const [sourceKind, setSourceKind] = useState<"fixture" | "merchant">("fixture");
  const [profileId, setProfileId] = useState("local-fixture");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dependenciesReady, setDependenciesReady] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch("/api/ready", { cache: "no-store" });
        const body = (await response.json()) as { ready?: boolean };
        if (active) setDependenciesReady(response.ok && body.ready === true);
      } catch {
        if (active) setDependenciesReady(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  async function startRun() {
    setError(null);
    setEvents([]);
    setRequestId(null);

    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction, mandateId, agentId, source: sourceKind === "fixture" ? { kind: "fixture", name: fixture } : { kind: "merchant", profileId } }),
    });
    const data = (await res.json()) as { requestId?: string; error?: { message: string } };
    if (!res.ok || !data.requestId) {
      setError(data.error?.message ?? "run failed to start");
      return;
    }

    setRequestId(data.requestId);
    const source = new EventSource(`/api/run/${data.requestId}/events`);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data as string) as RunEvent;
      setEvents((prev) => [...prev, event]);
    };
    source.onerror = () => source.close();
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem" }}>
      <h1>StraitsX mandated checkout</h1>
      <p style={{ color: "#666" }}>
        Start a deterministic security fixture or a checked-in merchant checkout profile.
      </p>
      <p role="status" style={{ color: dependenciesReady === true ? "green" : "darkorange" }}>
        {dependenciesReady === true
          ? "Payment dependencies ready"
          : dependenciesReady === false
            ? "Waiting for ledger, policy, and chain gateway"
            : "Checking payment dependencies…"}
      </p>

      <fieldset style={{ marginTop: "1.5rem" }}>
        <legend>Run</legend>
        <label style={{ display: "block", marginBottom: 8 }}>
          mandateId
          <input value={mandateId} onChange={(e) => setMandateId(e.target.value)} style={{ width: "100%" }} />
        </label>
        <label style={{ display: "block", marginBottom: 8 }}>
          agentId
          <input value={agentId} onChange={(e) => setAgentId(e.target.value)} style={{ width: "100%" }} />
        </label>
        <label style={{ display: "block", marginBottom: 8 }}>
          instruction
          <input value={instruction} onChange={(e) => setInstruction(e.target.value)} style={{ width: "100%" }} />
        </label>
        <label style={{ display: "block", marginBottom: 8 }}>
          source
          <select value={sourceKind} onChange={(e) => setSourceKind(e.target.value as "fixture" | "merchant")}>
            <option value="fixture">fixture</option><option value="merchant">merchant profile</option>
          </select>
        </label>
        {sourceKind === "fixture" ? <label style={{ display: "block", marginBottom: 8 }}>
          fixture
          <select value={fixture} onChange={(e) => setFixture(e.target.value as Fixture)}>
            {FIXTURES.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label> : <label style={{ display: "block", marginBottom: 8 }}>
          profileId <input value={profileId} onChange={(e) => setProfileId(e.target.value)} />
        </label>}
        <button onClick={startRun} disabled={dependenciesReady !== true}>Start run</button>
      </fieldset>

      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {requestId && (
        <p>
          requestId: <code>{requestId}</code>
        </p>
      )}

      <ol>
        {events.map((event) => (
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
