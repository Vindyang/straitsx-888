"use client";

import { useState } from "react";

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
    "Buy the 500ml stainless water bottle from shop.example, under S$20",
  );
  const [fixture, setFixture] = useState<Fixture>("clean");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function startRun() {
    setError(null);
    setEvents([]);
    setRequestId(null);

    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction, mandateId, agentId, fixture }),
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
      <h1>StraitsX — Module C scaffold</h1>
      <p style={{ color: "#666" }}>
        This page drives agent-orchestrator directly through the run pipeline (C1-C10). Mandate
        creation, the refusal panel, receipt view and spend meter (C11-C15) are a later phase.
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
          fixture
          <select value={fixture} onChange={(e) => setFixture(e.target.value as Fixture)}>
            {FIXTURES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={startRun}>Start run</button>
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
