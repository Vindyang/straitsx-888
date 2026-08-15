export const DEPENDENCY_NAMES = ["ledger", "policy", "chainGateway"] as const;

export type DependencyName = (typeof DEPENDENCY_NAMES)[number];
export type DependencyStatus = "ready" | "unavailable";

export type DependencyReadiness = {
  ready: boolean;
  dependencies: Record<DependencyName, DependencyStatus>;
};

export type DependencyReadinessCheck = () => Promise<DependencyReadiness>;

type DependencyReadinessOptions = {
  ledgerUrl: string;
  policyUrl: string;
  chainGatewayUrl: string;
  internalToken?: string | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
};

const unavailableDependencies = (): DependencyReadiness["dependencies"] => ({
  ledger: "unavailable",
  policy: "unavailable",
  chainGateway: "unavailable",
});

export function unavailableReadiness(): DependencyReadiness {
  return { ready: false, dependencies: unavailableDependencies() };
}

/**
 * Probe only the public liveness contract. Hostnames, response bodies and
 * transport failures are deliberately not returned or logged: readiness is an
 * operational signal, not a topology-disclosure endpoint.
 */
export function createDependencyReadinessCheck(options: DependencyReadinessOptions): DependencyReadinessCheck {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const urls: Record<DependencyName, string> = {
    ledger: options.ledgerUrl,
    policy: options.policyUrl,
    chainGateway: options.chainGatewayUrl,
  };

  return async () => {
    const entries = await Promise.all(
      DEPENDENCY_NAMES.map(async (name): Promise<[DependencyName, DependencyStatus]> => {
        try {
          const response = await fetchImpl(new URL("/health", urls[name]), {
            ...(options.internalToken ? { headers: { "x-internal-token": options.internalToken } } : {}),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) return [name, "unavailable"];
          const body: unknown = await response.json();
          const contractHealthy = typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
          return [name, contractHealthy ? "ready" : "unavailable"];
        } catch {
          return [name, "unavailable"];
        }
      }),
    );
    const dependencies = Object.fromEntries(entries) as DependencyReadiness["dependencies"];
    return { ready: DEPENDENCY_NAMES.every((name) => dependencies[name] === "ready"), dependencies };
  };
}

export function dependencyReadinessFromEnvironment(
  internalToken: string | undefined,
): DependencyReadinessCheck {
  return createDependencyReadinessCheck({
    ledgerUrl: process.env["LEDGER_URL"] ?? "http://localhost:4001",
    policyUrl: process.env["POLICY_URL"] ?? "http://localhost:4002",
    chainGatewayUrl: process.env["CHAIN_GATEWAY_URL"] ?? "http://localhost:4004",
    internalToken,
  });
}
