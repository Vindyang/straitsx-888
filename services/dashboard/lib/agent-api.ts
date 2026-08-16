export type AgentSnapshot = {
  agentId: string
  displayName: string
  instructions: string
  intent: string | null
  approved: boolean
  createdAt: string
  updatedAt: string
}

export type AgentRecord = {
  agentId: string
  displayName: string
  instructions: string
  intent: string | null
  approved: boolean
  createdAt: string
  updatedAt: string
}

export type ProductCandidate = {
  name: string
  price: string
  url?: string
  imageUrl?: string
}

export type AgentMessage = {
  messageId: string
  agentId: string
  role: "user" | "assistant"
  content: string
  createdAt: string
  inReplyTo?: string
  productCandidates?: ProductCandidate[]
}

export type AgentRun = {
  runId: string
  agentId: string
  status: "queued" | "running" | "succeeded" | "failed"
  request?: string
  response?: string
  error?: string
  createdAt: string
  updatedAt: string
}

export type PurchaseActivity = {
  activityId: string
  agentId: string
  runId: string
  productName: string
  price: string
  purchasedAt: string
}

const DEFAULT_AGENT_BASE_URL = process.env.AGENT_API_BASE_URL || ""

export class AgentApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "AgentApiError"
    this.status = status
  }
}

async function agentRequest<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)

  try {
    const res = await fetch(`/api/agent/v1/${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    })

    if (!res.ok) {
      let message = `Request failed with ${res.status}`
      try {
        const body = (await res.json()) as { message?: string; error?: string }
        message = body.message || body.error || message
      } catch {
        // ignore
      }
      throw new AgentApiError(res.status, message)
    }

    return (await res.json()) as T
  } catch (err) {
    if (err instanceof AgentApiError) throw err
    throw new AgentApiError(0, err instanceof Error ? err.message : "Network error")
  } finally {
    clearTimeout(timeout)
  }
}

export function listAgents(): Promise<AgentRecord[]> {
  return agentRequest<AgentRecord[]>("agents")
}

export function createAgent(input: {
  displayName: string
  instructions: string
}): Promise<AgentSnapshot> {
  return agentRequest<AgentSnapshot>("agents", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export function listMessages(agentId: string): Promise<AgentMessage[]> {
  return agentRequest<AgentMessage[]>(`agents/${agentId}/messages`)
}

export function createMessage(
  agentId: string,
  content: string,
  inReplyTo?: string
): Promise<AgentMessage & { runId?: string }> {
  return agentRequest<AgentMessage & { runId?: string }>(
    `agents/${agentId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ content, inReplyTo }),
    }
  )
}

export async function getRun(
  agentId: string,
  runId: string
): Promise<AgentRun> {
  return agentRequest<AgentRun>(`agents/${agentId}/runs/${runId}`)
}

/**
 * Polls a run until it leaves queued/running. Mirrors the StarNote frontend
 * (80 attempts x 750 ms); the dashboard proxy just relays to the Lambda API.
 */
export async function waitForRun(
  agentId: string,
  runId: string,
  signal?: AbortSignal
): Promise<AgentRun> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (signal?.aborted) {
      throw new AgentApiError(0, "Aborted")
    }
    const run = await getRun(agentId, runId)
    if (run.status === "succeeded" || run.status === "failed") return run
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
  throw new AgentApiError(0, "Timed out waiting for the agent run")
}

export function createAgentClient(baseUrl = "") {
  void baseUrl
  return { listAgents, createAgent, listMessages, createMessage, getRun }
}