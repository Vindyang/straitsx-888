/**
 * C16-shopify — complete a UCP checkout with a StraitsX virtual card payment
 * instrument, the way Shopify's Universal Commerce Protocol prescribes:
 *
 *   POST /checkout-sessions/{checkout_session_id}/complete
 *   UCP-Platform: profile="<platform profile URL>"
 *   { "payment_data": { id, handler_id, type, selected, credential } }
 *
 * Shop Pay (dev.shopify.shop_pay) is Shopify's built-in handler; merchants can
 * also accept custom payment instruments that declare their own handler. We
 * present the StraitsX virtual card as `dev.straitsx.card` — a network-token
 * credential issued by StraitsX's card issuer (see docs/shopify-agentic-payments.md).
 * The merchant PSP charges the card; StraitsX settles the merchant over card
 * network rails; our pipeline funds the card seamlessly from the mandate (the
 * EIP-3009 leg) and finalizes settlement at capture time.
 */
import type { ShopifyUcpCheckout } from "../discovery/discover";

const UCP_CHECKOUT_API_URL = (process.env["UCP_CHECKOUT_API_URL"] ?? "").replace(/\/$/, "");
const UCP_PLATFORM_PROFILE_URL = process.env["UCP_PLATFORM_PROFILE_URL"] ?? "";
/** Comma-separated relay hosts allowed as UCP checkout endpoints (in addition to
 *  the store's own domain, which the policy commit already pinned). */
const UCP_CHECKOUT_RELAY_HOSTS = (process.env["UCP_CHECKOUT_RELAY_HOSTS"] ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);

export type SpendLeg = {
  requestId: string;
  merchantDomain: string;
  orderTotal: string;
  itemSku: string;
  orderId: string;
  observedAt: string;
  proof: "ucp";
};

export type UcpCheckoutInput = {
  requestId: string;
  checkout: ShopifyUcpCheckout;
  cardOpaqueId: string;
  settlementTx: string;
  onDomainAsserted?: () => void;
};

export async function completeUcpCheckout(
  input: UcpCheckoutInput,
): Promise<SpendLeg> {
  const endpoint = new URL(
    `checkout-sessions/${input.checkout.checkoutSessionId}/complete`,
    UCP_CHECKOUT_API_URL || `https://${input.checkout.storeDomain}`,
  );
  const host = endpoint.hostname.toLowerCase();
  const hostAllowed = host === input.checkout.storeDomain.toLowerCase() || UCP_CHECKOUT_RELAY_HOSTS.includes(host);
  if (!hostAllowed) {
    throw new Error("UCP checkout endpoint host is not the committed store domain nor an allowlisted relay");
  }
  input.onDomainAsserted?.();

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (UCP_PLATFORM_PROFILE_URL) {
    headers["ucp-platform"] = `profile="${UCP_PLATFORM_PROFILE_URL}"`;
  }

  // UCP payment instrument for the StraitsX virtual card (handler extension point).
  const paymentData = {
    id: `instr_straitsx_${input.requestId}`,
    handler_id: "straitsx_card",
    type: "straitsx_card",
    selected: true,
    credential: {
      type: "card_network_token",
      token: `tok_straitsx_${input.cardOpaqueId}`,
      settlementTx: input.settlementTx,
    },
  };

  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ payment_data: paymentData }) });
  if (!response.ok) {
    throw new Error(`UCP checkout completion returned ${response.status}`);
  }
  const completed = (await response.json()) as { order?: { id?: string } };
  const orderId = completed.order?.id;
  if (!orderId) throw new Error("UCP checkout completion did not return an order id");
  return {
    requestId: input.requestId,
    merchantDomain: input.checkout.storeDomain,
    orderTotal: input.checkout.totalBaseUnits,
    itemSku: input.checkout.sku,
    orderId,
    observedAt: new Date().toISOString(),
    proof: "ucp",
  };
}