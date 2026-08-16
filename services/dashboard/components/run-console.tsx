"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { FUJI } from "@straitsx/contracts"
import {
  RiArrowRightLine,
  RiErrorWarningLine,
  RiRobot2Line,
  RiSendPlane2Line,
  RiUser3Line,
  RiVisaLine,
} from "@remixicon/react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ChatMarkdown } from "@/components/chat-markdown"
import {
  AgentApiError,
  createAgent,
  createMessage,
  listMessages,
  waitForRun,
} from "@/lib/agent-api"
import { sgdToBaseUnits, shortHex } from "@/lib/format"
import {
  connectWallet,
  sendTransaction,
  waitForReceipt,
  type UnsignedTx,
} from "@/lib/wallet"

type ChatBlock =
  | { kind: "user"; id: string; content: string }
  | { kind: "assistant"; id: string; runId: string; content: string }

const FIXTURES = ["clean", "poisoned-recipient", "poisoned-amount", "wrong-item"] as const
type Fixture = (typeof FIXTURES)[number]

const DAY_SECONDS = 86_400

function defaultMandateForm(agentId: string, intentConstraint: string) {
  const now = Math.floor(Date.now() / 1000)
  return {
    owner: "",
    agentId,
    chainId: FUJI.chainId,
    asset: FUJI.xsgd,
    settlementRecipient: FUJI.settlementRecipient ?? "",
    maxPerCardSgd: "30",
    maxPerWindowSgd: "100",
    maxCardsPerWindow: 5,
    windowSeconds: DAY_SECONDS,
    maxAuthValiditySeconds: 300,
    expiresAt: now + 30 * DAY_SECONDS,
    intentConstraint: intentConstraint.slice(0, 180),
    merchantAllowlist: "localhost",
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof AgentApiError && error.status === 401) {
    if (error.message.includes("AGENT_API_ACCESS_TOKEN")) return error.message
    return "The agent API rejected the request (status 401). Set AGENT_API_ACCESS_TOKEN on the server."
  }
  if (error instanceof Error) return error.message
  return "The request could not be completed."
}

export function RunConsole() {
  const [agentId, setAgentId] = useState<string | null>(null)
  const [instruction, setInstruction] = useState("")
  const [blocks, setBlocks] = useState<ChatBlock[]>([])
  const [processingPhase, setProcessingPhase] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dependenciesReady, setDependenciesReady] = useState<boolean | null>(null)

  const endRef = useRef<HTMLDivElement>(null)

  const processing = processingPhase !== null

  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const response = await fetch("/api/ready", { cache: "no-store" })
        const body = (await response.json()) as { ready?: boolean }
        if (active) setDependenciesReady(response.ok && body.ready === true)
      } catch {
        if (active) setDependenciesReady(false)
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 10_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" })
  }, [blocks, processingPhase])

  async function submitRequest(request: string) {
    if (!request.trim() || processing) return

    const messageText = request.trim()
    setInstruction("")
    setError(null)
    setBlocks((current) => [
      ...current,
      { kind: "user", id: `user-${crypto.randomUUID()}`, content: messageText },
    ])

    try {
      let currentAgentId = agentId
      if (!currentAgentId) {
        setProcessingPhase("Creating the agent and mapping the intent…")
        const created = await createAgent({
          displayName: "StraitsX shopper",
          instructions:
            "You turn a user's shopping request into a concrete, explicit purchase intent. Keep responses concise, list candidate products when relevant, and never invent merchants.",
        })
        currentAgentId = created.agentId
        setAgentId(currentAgentId)
      }

      setProcessingPhase("Waiting for the agent…")
      const queued = await createMessage(currentAgentId, messageText)
      if (!queued.runId) throw new Error("the agent accepted the message but returned no run id")
      const run = await waitForRun(currentAgentId, queued.runId)

      const fresh = await listMessages(currentAgentId)

      if (run.status === "succeeded" && run.response) {
        const latestAssistant = [...fresh].reverse().find((m) => m.role === "assistant")
        const assistantContent = latestAssistant?.content ?? run.response
        setBlocks((current) => [
          ...current,
          {
            kind: "assistant",
            id: run.runId,
            runId: run.runId,
            content: assistantContent,
          },
        ])
      } else {
        throw new Error(run.error ?? "the agent run did not complete")
      }
    } catch (submitError) {
      setError(errorMessage(submitError))
    } finally {
      setProcessingPhase(null)
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await submitRequest(instruction)
  }

  return (
    <Card className="sm:min-h-[36rem]">
      <CardHeader className="border-b">
        <CardTitle>Run with StraitsX</CardTitle>
        <CardDescription>
          {dependenciesReady === true
            ? "Ledger, policy, and chain gateway are ready."
            : dependenciesReady === false
              ? "Waiting for ledger, policy, and chain gateway."
              : "Checking payment dependencies…"}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? (
          <Alert variant="destructive">
            <RiErrorWarningLine aria-hidden="true" />
            <AlertTitle>Request unsuccessful</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div
          role="log"
          aria-live="polite"
          aria-busy={processing}
          className="flex max-h-[34rem] min-h-52 flex-col gap-6 overflow-y-auto pr-2"
        >
          <div className="flex max-w-[90%] items-start gap-3">
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center border bg-muted"
            >
              <RiRobot2Line className="size-4" />
            </span>
            <p className="border-l-2 border-primary px-4 py-2 text-sm leading-6">
              Tell me what to buy, and under what constraint — e.g. "Buy the 500ml
              stainless water bottle from localhost under S$20". I&apos;ll draft the
              intent, you create a live mandate, and it runs through every policy
              check before anything signs.
            </p>
          </div>

          {blocks.map((block) =>
            block.kind === "user" ? (
              <div key={block.id} className="flex max-w-[90%] items-start gap-3 self-end">
                <p className="bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground">
                  {block.content}
                </p>
                <span
                  aria-hidden="true"
                  className="flex size-9 shrink-0 items-center justify-center border"
                >
                  <RiUser3Line className="size-4" />
                </span>
              </div>
            ) : (
              <div key={block.id} className="flex w-full flex-col gap-4">
                <div className="flex max-w-[90%] items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-9 shrink-0 items-center justify-center border bg-muted"
                  >
                    <RiRobot2Line className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1 border-l-2 border-primary px-4 py-2 text-sm leading-6">
                    <div className="[&>*+*]:mt-2">
                      <ChatMarkdown>{block.content}</ChatMarkdown>
                    </div>
                  </div>
                </div>
                <div className="pl-0 sm:pl-12">
                  <RunFlowCard instruction={block.content} agentId={agentId} />
                </div>
              </div>
            ),
          )}

          {processingPhase ? (
            <div className="flex max-w-[90%] items-start gap-3">
              <span
                aria-hidden="true"
                className="flex size-9 shrink-0 items-center justify-center border bg-muted"
              >
                <RiRobot2Line className="size-4" />
              </span>
              <div className="border-l-2 border-primary px-4 py-2">
                <p className="text-sm font-medium">{processingPhase}</p>
              </div>
            </div>
          ) : null}
          <div ref={endRef} />
        </div>
      </CardContent>

      <CardFooter className="border-t">
        <form className="w-full" onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="run-request" className="sr-only">
                Run request
              </FieldLabel>
              <Textarea
                id="run-request"
                name="run-request"
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="Buy the 500ml stainless steel water bottle from localhost, under S$20"
                rows={3}
                disabled={processing}
              />
              <FieldDescription>
                The message goes to the agent first — then the mandatory-run workflow
                continues right here in the thread.
              </FieldDescription>
            </Field>
            <Button
              type="submit"
              size="lg"
              className="min-h-11 w-full sm:w-fit sm:self-end"
              disabled={!instruction.trim() || processing}
            >
              <RiSendPlane2Line data-icon="inline-start" />
              {processing ? "Processing" : "Send"}
            </Button>
          </FieldGroup>
        </form>
      </CardFooter>
    </Card>
  )
}

type RunEvent = {
  seq: number
  stage: string
  status?: string
  check?: string
  at: string
}

/**
 * The continuous mandate→run workflow, rendered inside the chat thread right
 * below each assistant reply: create/select a mandate, then start the run —
 * its events stream into the same card.
 */
function RunFlowCard({
  instruction,
  agentId,
}: {
  instruction: string
  agentId: string | null
}) {
  const [step, setStep] = useState<"mandate" | "run">("mandate")
  const [mandateIds, setMandateIds] = useState<string[]>([])
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [form, setForm] = useState(() =>
    defaultMandateForm(agentId ?? "", instruction)
  )
  const [selectedMandateId, setSelectedMandateId] = useState("")
  const [mandateBusy, setMandateBusy] = useState<string | null>(null)
  const [flowError, setFlowError] = useState<string | null>(null)

  const [sourceKind, setSourceKind] = useState<"fixture" | "merchant">("fixture")
  const [fixture, setFixture] = useState<Fixture>("clean")
  const [profileId, setProfileId] = useState("local-fixture")
  const [requestId, setRequestId] = useState<string | null>(null)
  const [runEvents, setRunEvents] = useState<RunEvent[]>([])
  const [runBusy, setRunBusy] = useState(false)

  const eventSourcesRef = useRef<EventSource[]>([])

  useEffect(() => {
    let active = true
    fetch("/api/mandates", { cache: "no-store" })
      .then((res) => res.json() as Promise<Array<{ mandate: { mandateId: string } }>>)
      .then((rows) => {
        if (!active) return
        const ids = rows.map((row) => row.mandate.mandateId)
        setMandateIds(ids)
        if (ids.length === 1) setSelectedMandateId(ids[0])
      })
      .catch(() => undefined)
    return () => {
      active = false
      eventSourcesRef.current.forEach((source) => source.close())
    }
  }, [])

  async function connectOwner() {
    setFlowError(null)
    try {
      const account = await connectWallet()
      setForm((prev) => ({ ...prev, owner: account }))
    } catch (err) {
      setFlowError(errorMessage(err))
    }
  }

  async function createMandate() {
    setFlowError(null)
    setMandateBusy("signing createMandate…")
    try {
      const body = {
        owner: form.owner,
        agentId: form.agentId,
        chainId: form.chainId,
        asset: form.asset,
        settlementRecipient: form.settlementRecipient,
        maxPerCard: sgdToBaseUnits(form.maxPerCardSgd),
        maxPerWindow: sgdToBaseUnits(form.maxPerWindowSgd),
        maxCardsPerWindow: form.maxCardsPerWindow,
        windowSeconds: form.windowSeconds,
        maxAuthValiditySeconds: form.maxAuthValiditySeconds,
        expiresAt: form.expiresAt,
        intentConstraint: form.intentConstraint,
        merchantAllowlist: form.merchantAllowlist
          .split(",")
          .map((domain) => domain.trim())
          .filter(Boolean),
      }
      const buildRes = await fetch("/api/mandates", {
        method: "POST",
        body: JSON.stringify(body),
      })
      const built = (await buildRes.json()) as {
        mandateId?: string
        unsignedTx?: UnsignedTx
        error?: { message: string }
      }
      if (!buildRes.ok || !built.mandateId || !built.unsignedTx) {
        throw new Error(built.error?.message ?? "failed to build createMandate tx")
      }

      const txHash = await sendTransaction(built.unsignedTx)
      setMandateBusy("waiting for createMandate on-chain…")
      await waitForReceipt(txHash)

      setMandateBusy("saving the policy body…")
      const confirmRes = await fetch(`/api/mandates/${built.mandateId}/confirm`, {
        method: "POST",
      })
      if (!confirmRes.ok) {
        const detail = (await confirmRes.json().catch(() => ({}))) as {
          error?: { message?: string }
        }
        throw new Error(
          detail.error?.message ?? "createMandate mined, but saving the policy body failed"
        )
      }

      setSelectedMandateId(built.mandateId)
      setMandateIds((current) =>
        current.includes(built.mandateId as string)
          ? current
          : [...current, built.mandateId as string]
      )
      setStep("run")
    } catch (err) {
      setFlowError(errorMessage(err))
    } finally {
      setMandateBusy(null)
    }
  }

  function selectExisting() {
    setFlowError(null)
    if (!selectedMandateId) return
    setStep("run")
  }

  async function startRun() {
    setFlowError(null)
    setRunBusy(true)
    try {
      if (!selectedMandateId) throw new Error("create or select a mandate first")

      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instruction,
          mandateId: selectedMandateId,
          agentId: agentId ?? undefined,
          source:
            sourceKind === "fixture"
              ? { kind: "fixture", name: fixture }
              : { kind: "merchant", profileId },
        }),
      })
      const data = (await res.json()) as {
        requestId?: string
        error?: { message: string }
      }
      if (!res.ok || !data.requestId) {
        throw new Error(data.error?.message ?? "run failed to start")
      }

      const currentRequestId = data.requestId
      setRequestId(currentRequestId)
      setRunEvents([])

      const source = new EventSource(`/api/run/${currentRequestId}/events`)
      eventSourcesRef.current.push(source)
      source.onmessage = (message) => {
        const event = JSON.parse(message.data as string) as RunEvent
        setRunEvents((current) =>
          current.some((e) => e.seq === event.seq)
            ? current
            : [...current, event]
        )
      }
      source.onerror = () => source.close()
      source.addEventListener("closed", () => source.close())
    } catch (err) {
      setFlowError(errorMessage(err))
    } finally {
      setRunBusy(false)
    }
  }

  const terminalStatus = ["DONE", "REFUSED", "ESCALATED", "FAILED", "AWAITING_CHECKOUT"].find(
    (terminal) => runEvents.some((event) => event.status === terminal)
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <RiVisaLine className="size-4" />
            Mandate → run
          </CardTitle>
          <span
            className={`text-xs font-medium ${
              terminalStatus
                ? "text-primary"
                : requestId
                  ? "text-muted-foreground"
                  : "text-muted-foreground"
            }`}
          >
            {step === "run" && requestId
              ? terminalStatus ?? "running…"
              : step === "mandate"
                ? "step 1 of 2"
                : "step 2 of 2"}
          </span>
        </div>
        <CardDescription>
          One workflow: the mandate authorizes your intent, then the run executes it
          through every policy check — nothing signs without the mandate.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {flowError ? (
          <Alert variant="destructive">
            <RiErrorWarningLine aria-hidden="true" />
            <AlertTitle>Workflow unsuccessful</AlertTitle>
            <AlertDescription>{flowError}</AlertDescription>
          </Alert>
        ) : null}

        {step === "mandate" ? (
          <div className="space-y-4">
            {mandateIds.length > 0 ? (
              <div className="space-y-2">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="flow-mandate-select">Existing mandate</FieldLabel>
                    <select
                      id="flow-mandate-select"
                      value={selectedMandateId}
                      onChange={(event) => setSelectedMandateId(event.target.value)}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    >
                      <option value="">— select —</option>
                      {mandateIds.map((id) => (
                        <option key={id} value={id}>
                          {shortHex(id)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </FieldGroup>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    onClick={selectExisting}
                    disabled={!selectedMandateId || mandateBusy !== null}
                  >
                    Use this mandate
                    <RiArrowRightLine data-icon="inline-end" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowCreateForm((current) => !current)}
                    disabled={mandateBusy !== null}
                  >
                    Create a new mandate
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No mandates yet — create one for this intent.
              </p>
            )}

            {showCreateForm || mandateIds.length === 0 ? (
              <div className="space-y-3 rounded-md border p-4">
                <FieldGroup>
                  <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                    <Field>
                      <FieldLabel htmlFor="flow-owner">owner (your wallet)</FieldLabel>
                      <Input
                        id="flow-owner"
                        value={form.owner}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, owner: event.target.value }))
                        }
                        placeholder="0x…"
                      />
                    </Field>
                    <div className="flex items-end pb-1">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={connectOwner}
                        disabled={mandateBusy !== null}
                      >
                        Use wallet
                      </Button>
                    </div>
                  </div>
                  <Field>
                    <FieldLabel htmlFor="flow-intent">intentConstraint</FieldLabel>
                    <Input
                      id="flow-intent"
                      value={form.intentConstraint}
                      onChange={(event) =>
                        setForm((prev) => ({
                          ...prev,
                          intentConstraint: event.target.value,
                        }))
                      }
                    />
                    <FieldDescription>
                      Prefilled from your request; the policy hashes it into the mandate.
                    </FieldDescription>
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field>
                      <FieldLabel htmlFor="flow-max-per-card">maxPerCard (SGD)</FieldLabel>
                      <Input
                        id="flow-max-per-card"
                        value={form.maxPerCardSgd}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, maxPerCardSgd: event.target.value }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="flow-max-per-window">maxPerWindow (SGD)</FieldLabel>
                      <Input
                        id="flow-max-per-window"
                        value={form.maxPerWindowSgd}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, maxPerWindowSgd: event.target.value }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="flow-max-cards">maxCardsPerWindow</FieldLabel>
                      <Input
                        id="flow-max-cards"
                        type="number"
                        value={form.maxCardsPerWindow}
                        onChange={(event) =>
                          setForm((prev) => ({
                            ...prev,
                            maxCardsPerWindow: Number(event.target.value),
                          }))
                        }
                      />
                    </Field>
                  </div>
                </FieldGroup>
                <Button
                  type="button"
                  onClick={createMandate}
                  disabled={mandateBusy !== null || !form.owner}
                >
                  {mandateBusy ?? "Build + sign createMandate"}
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="flow-source">source</FieldLabel>
                  <select
                    id="flow-source"
                    value={sourceKind}
                    onChange={(event) =>
                      setSourceKind(event.target.value as "fixture" | "merchant")
                    }
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    <option value="fixture">fixture</option>
                    <option value="merchant">merchant profile</option>
                  </select>
                </Field>
                {sourceKind === "fixture" ? (
                  <Field>
                    <FieldLabel htmlFor="flow-fixture">fixture</FieldLabel>
                    <select
                      id="flow-fixture"
                      value={fixture}
                      onChange={(event) => setFixture(event.target.value as Fixture)}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    >
                      {FIXTURES.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  <Field>
                    <FieldLabel htmlFor="flow-profile">profileId</FieldLabel>
                    <Input
                      id="flow-profile"
                      value={profileId}
                      onChange={(event) => setProfileId(event.target.value)}
                    />
                  </Field>
                )}
              </FieldGroup>
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              mandate <code className="font-mono">{shortHex(selectedMandateId)}</code>
            </div>

            <Button
              type="button"
              onClick={startRun}
              disabled={runBusy || !selectedMandateId}
              className="w-full"
            >
              {runBusy ? "Starting…" : runEvents.length > 0 ? "Run again" : "Start run"}
            </Button>

            {runEvents.length > 0 ? (
              <ol className="space-y-1 rounded-md border p-4 text-sm">
                {runEvents.map((event) => (
                  <li key={event.seq} className="flex gap-2">
                    <span className="text-muted-foreground">{event.stage}</span>
                    {event.status ? <span className="font-medium">{event.status}</span> : null}
                    {event.check ? (
                      <span className="text-muted-foreground/80">({event.check})</span>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : null}

            {terminalStatus === "DONE" && requestId ? (
              <Link
                href={`/runs/${requestId}`}
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                Open run detail <RiArrowRightLine className="size-4" />
              </Link>
            ) : terminalStatus && terminalStatus !== "DONE" && requestId ? (
              <Link
                href={`/runs/${requestId}`}
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                Review outcome <RiArrowRightLine className="size-4" />
              </Link>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}