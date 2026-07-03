// Supabase Edge Function: send-ticket-sms
// Sends a one-way SMS to a customer via ClickSend (an Australian SMS
// provider). The ClickSend credentials live in Supabase secrets, never
// in the public dashboard page.
//
// Three actions:
//   1) Send SMS  — body { "to", "message", "shortenUrl" } -> { ok, status }
//   2) Balance   — body { "action": "balance" }           -> { ok, balance, prefix, currency }
//      (reuses the same sealed ClickSend key; never exposes it)
//   3) Shorten   — body { "action": "shorten", "url" }    -> { ok, url }
//      (is.gd short link for the dashboard's manual SMS fallback)
//
// Deploy:
//   supabase functions deploy send-ticket-sms --project-ref ebqiitxiyzzbkgyfypss
// Secrets (set once):
//   supabase secrets set CLICKSEND_USERNAME=you@example.com \
//                        CLICKSEND_API_KEY=xxxxxxxx \
//                        CLICKSEND_SENDER=ChatswdVlt \
//                        --project-ref ebqiitxiyzzbkgyfypss

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const USERNAME = Deno.env.get("CLICKSEND_USERNAME") ?? "";
const API_KEY = Deno.env.get("CLICKSEND_API_KEY") ?? "";
// Optional alphanumeric sender ID — max 11 chars. Leave the secret unset
// to send from ClickSend's shared number (no sender-ID registration needed).
const SENDER = Deno.env.get("CLICKSEND_SENDER") ?? "";

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

function authHeader(): string {
  return "Basic " + btoa(`${USERNAME}:${API_KEY}`);
}

// Normalise an Australian mobile to E.164 (+61…). Accepts "0433 273 377",
// "0433273377", "+61433273377", "61433273377".
function toE164AU(raw: string): string {
  let n = String(raw).replace(/[^\d+]/g, "");
  if (n.startsWith("+")) return n;
  if (n.startsWith("0")) return "+61" + n.slice(1);
  if (n.startsWith("61")) return "+" + n;
  return "+61" + n;
}

// Mask all but the last 3 digits for logs.
function mask(n: string): string {
  return n.length > 4 ? n.slice(0, 3) + "***" + n.slice(-3) : "***";
}

// Shorten a long ticket URL via is.gd's keyless API so the customer sees a
// clean "is.gd/xxxx" link instead of the raw GitHub Pages address. is.gd does
// a direct 301 redirect (no "preview / go to destination" interstitial that
// TinyURL sometimes shows), so the QR page opens straight away. Server-side
// avoids browser CORS limits. Returns null on any failure so the caller can
// fall back to the original (still-working) long URL.
async function shorten(longUrl: string): Promise<string | null> {
  try {
    const r = await fetch(
      "https://is.gd/create.php?format=simple&url=" + encodeURIComponent(longUrl),
    );
    if (!r.ok) return null;
    const t = (await r.text()).trim();
    // format=simple returns just the short URL, or an "Error: ..." string on
    // failure (which won't match this, so we fall back to the long URL).
    return /^https?:\/\/\S+$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  if (!USERNAME || !API_KEY) {
    return json({ ok: false, error: "SMS not configured (missing ClickSend secrets)" }, 503);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  // ── Action: balance check ──────────────────────────────────────────────
  // Returns the live ClickSend account balance using the same sealed key,
  // without ever exposing the key to the public caller.
  if (body && body.action === "balance") {
    try {
      const res = await fetch("https://rest.clicksend.com/v3/account", {
        headers: { "Authorization": authHeader() },
      });
      const data = await res.json();
      const acct = (data?.data ?? {}) as Record<string, any>;
      const balance = parseFloat(acct.balance);
      const prefix = acct?.currency?.currency_prefix ?? "$";
      const currency = acct?.currency?.currency_code ?? "";
      console.log(`[send-ticket-sms] balance check httpOk=${res.ok} balance=${acct.balance} ${currency}`);
      return json({
        ok: res.ok && !isNaN(balance),
        balance: isNaN(balance) ? null : balance,
        prefix,
        currency,
      }, res.ok ? 200 : 502);
    } catch (e) {
      console.error(`[send-ticket-sms] BALANCE ERROR ${String(e)}`);
      return json({ ok: false, error: String(e) }, 502);
    }
  }

  // ── Action: shorten only ───────────────────────────────────────────────
  // Returns a short link for the given URL, reusing the same is.gd shortener.
  // Used by the dashboard's manual SMS fallback (operator's own Messages app /
  // share sheet) so the customer never sees the long GitHub Pages address.
  // Falls back to the original URL if shortening fails (still a working link).
  if (body && body.action === "shorten") {
    const url = (body.url ?? "").toString().trim();
    if (!url) return json({ ok: false, error: "missing 'url'" }, 400);
    const short = await shorten(url);
    return json({ ok: true, url: short ?? url });
  }

  // ── Action: send SMS (default) ─────────────────────────────────────────
  const to = (body.to ?? "").toString().trim();
  let message = (body.message ?? "").toString();
  // Optional: a long URL inside `message` to swap for a short one.
  const shortenUrl = (body.shortenUrl ?? "").toString().trim();
  if (!to || !message) return json({ ok: false, error: "missing 'to' or 'message'" }, 400);

  // Replace the long ticket link with a tidy short link before sending. If the
  // shortener fails, `message` is left untouched (the full link still works).
  if (shortenUrl && message.includes(shortenUrl)) {
    const short = await shorten(shortenUrl);
    if (short) message = message.split(shortenUrl).join(short);
  }

  const number = toE164AU(to);
  console.log(`[send-ticket-sms] -> to=${mask(number)} sender=${SENDER || "(shared)"} msgLen=${message.length}`);

  try {
    const res = await fetch("https://rest.clicksend.com/v3/sms/send", {
      method: "POST",
      headers: {
        "Authorization": authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          // Only include `from` when a registered sender ID is configured;
          // otherwise ClickSend uses a shared number (no nag, still delivers).
          SENDER
            ? { source: "valet", from: SENDER, to: number, body: message }
            : { source: "valet", to: number, body: message },
        ],
      }),
    });
    const data = await res.json();
    const m = data?.data?.messages?.[0];
    const status = m?.status ?? data?.response_code ?? "UNKNOWN";
    const ok = res.ok && typeof status === "string" &&
      /success|queued|sent/i.test(status);
    // Log the full ClickSend reply server-side for diagnostics (status, price,
    // errors, balance) — but never return it to the public caller.
    console.log(`[send-ticket-sms] <- httpOk=${res.ok} status=${status} price=${m?.message_price} resp=${JSON.stringify(data)}`);
    return json({ ok, status, cost: m?.message_price, raw: ok ? undefined : data }, ok ? 200 : 502);
  } catch (e) {
    console.error(`[send-ticket-sms] FETCH ERROR ${String(e)}`);
    return json({ ok: false, error: String(e) }, 502);
  }
});
