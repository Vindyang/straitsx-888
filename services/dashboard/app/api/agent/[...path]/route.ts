// Server proxy: forwards dashboard /api/agent/* calls to the live StarNote agent API
// (infra/agent-service, stack starnote-v2-backend). The browser never talks to the
// Lambda API directly; tokens stay server-side.
import { NextRequest, NextResponse } from "next/server"

export const dynamic = "force-dynamic"

export const runtime = "nodejs"

// The live deployment of infra/agent-service (stack starnote-v2-backend). The env
// override exists for running against a different stack; the deployed URL is the
// default so nothing breaks when the env is unset.
const AGENT_API_BASE_URL =
  process.env.AGENT_API_BASE_URL ||
  "https://gasojigyqd.execute-api.ap-southeast-1.amazonaws.com"
const AGENT_API_ACCESS_TOKEN = process.env.AGENT_API_ACCESS_TOKEN || ""

function error(status: number, message: string) {
  return NextResponse.json({ error: message }, { status })
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  return proxy(req, ctx, "GET")
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  return proxy(req, ctx, "POST")
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  return proxy(req, ctx, "DELETE")
}

async function proxy(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
  method: string
) {
  if (!AGENT_API_BASE_URL) {
    return error(
      503,
      "AGENT_API_BASE_URL is not configured on the server. Set it to the live agent API URL."
    )
  }

  const { path } = await ctx.params
  const upstream = `${AGENT_API_BASE_URL.replace(/\/$/, "")}/${path.join("/")}`

  let body: string | undefined
  if (method !== "GET") {
    body = await req.text()
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  const token = AGENT_API_ACCESS_TOKEN || req.headers.get("authorization") || ""
  if (token) {
    headers.Authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`
  } else if (process.env.NODE_ENV !== "production") {
    // The live API's Cognito authorizer rejects anonymous calls with 401. Surface
    // the missing token as a message instead of an opaque error — but only in dev;
    // production keeps the hard 401 so misconfiguration is obvious.
    return error(
      401,
      "AGENT_API_ACCESS_TOKEN is not configured on the server. Add it to services/dashboard/.env — a Cognito access token for the starnote-agents audience/scopes."
    )
  }

  let res: Response
  try {
    res = await fetch(upstream, {
      method,
      headers,
      body,
      cache: "no-store",
    })
  } catch {
    return error(502, `Failed to reach the agent API. Is it deployed? (${upstream})`)
  }

  const text = await res.text()
  return new NextResponse(text, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("content-type") || "application/json",
    },
  })
}