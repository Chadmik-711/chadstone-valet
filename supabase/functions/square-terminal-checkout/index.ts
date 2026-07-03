// Supabase Edge Function: square-terminal-checkout
// Drives card payments on a Square Terminal from the valet dashboard.
// The Square access token lives in Supabase secrets, never in the page.
//
// Actions (POST JSON):
//   { action:"create", amountCents, deviceId, reference } -> { ok, checkoutId, status }
//   { action:"status", checkoutId }                        -> { ok, status, cardBrand, last4 }
//   { action:"cancel", checkoutId }                        -> { ok, status }
//
// Sandbox by default. To go live: set SQUARE_ENV=production and use a live token.
//
// Deploy:
//   supabase functions deploy square-terminal-checkout --project-ref ebqiitxiyzzbkgyfypss
// Secrets (set once — use your SANDBOX token first):
//   supabase secrets set SQUARE_ACCESS_TOKEN=EAAA... --project-ref ebqiitxiyzzbkgyfypss
//   (optional) supabase secrets set SQUARE_ENV=sandbox --project-ref ebqiitxiyzzbkgyfypss

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const TOKEN = Deno.env.get("SQUARE_ACCESS_TOKEN") ?? "";
const ENV = (Deno.env.get("SQUARE_ENV") ?? "sandbox").toLowerCase();
const VERSION = Deno.env.get("SQUARE_VERSION") ?? "2024-12-18";
const BASE = ENV === "production"
  ? "https://connect.squareup.com"
  : "https://connect.squareupsandbox.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
function sq(path: string, method: string, body?: unknown) {
  return fetch(BASE + path, {
    method,
    headers: {
      "Authorization": "Bearer " + TOKEN,
      "Square-Version": VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (!TOKEN) return json({ ok: false, error: "Square not configured (missing SQUARE_ACCESS_TOKEN)" }, 503);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid JSON" }, 400); }
  const action = String(body.action ?? "create");

  try {
    // ── Create a Terminal Checkout (sends the amount to the device) ──
    if (action === "create") {
      const amountCents = Math.round(Number(body.amountCents) || 0);
      const deviceId = String(body.deviceId ?? "").trim();
      if (amountCents <= 0) return json({ ok: false, error: "amount must be greater than 0" }, 400);
      if (!deviceId) return json({ ok: false, error: "missing terminal device ID" }, 400);
      const res = await sq("/v2/terminals/checkouts", "POST", {
        idempotency_key: crypto.randomUUID(),
        checkout: {
          amount_money: { amount: amountCents, currency: "AUD" },
          device_options: { device_id: deviceId },
          note: String(body.reference ?? "Valet parking").slice(0, 60),
        },
      });
      const d = await res.json();
      if (!res.ok) {
        console.error(`[square] create failed ${res.status} ${JSON.stringify(d)}`);
        return json({ ok: false, error: d?.errors?.[0]?.detail ?? `HTTP ${res.status}` }, 502);
      }
      return json({ ok: true, checkoutId: d.checkout?.id, status: d.checkout?.status });
    }

    // ── Poll a checkout's status ──
    if (action === "status") {
      const id = String(body.checkoutId ?? "").trim();
      if (!id) return json({ ok: false, error: "missing checkoutId" }, 400);
      const res = await sq("/v2/terminals/checkouts/" + id, "GET");
      const d = await res.json();
      if (!res.ok) return json({ ok: false, error: d?.errors?.[0]?.detail ?? `HTTP ${res.status}` }, 502);
      const co = d.checkout ?? {};
      const tender = co.payment_ids ? co.payment_ids[0] : null;
      return json({ ok: true, status: co.status, paymentId: tender, amount: co.amount_money?.amount });
    }

    // ── Cancel a pending checkout ──
    if (action === "cancel") {
      const id = String(body.checkoutId ?? "").trim();
      if (!id) return json({ ok: false, error: "missing checkoutId" }, 400);
      const res = await sq("/v2/terminals/checkouts/" + id + "/cancel", "POST");
      const d = await res.json();
      if (!res.ok) return json({ ok: false, error: d?.errors?.[0]?.detail ?? `HTTP ${res.status}` }, 502);
      return json({ ok: true, status: d.checkout?.status });
    }

    // ── Clear stuck checkouts (cancel any PENDING / IN_PROGRESS) ──
    if (action === "clearPending") {
      let cancelled = 0;
      for (const status of ["PENDING", "IN_PROGRESS"]) {
        const res = await sq("/v2/terminals/checkouts/search", "POST", { query: { filter: { status } }, limit: 100 });
        const d = await res.json();
        for (const co of (d.checkouts || [])) {
          await sq("/v2/terminals/checkouts/" + co.id + "/cancel", "POST");
          cancelled++;
        }
      }
      return json({ ok: true, cancelled });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    console.error(`[square] ERROR ${String(e)}`);
    return json({ ok: false, error: String(e) }, 502);
  }
});
