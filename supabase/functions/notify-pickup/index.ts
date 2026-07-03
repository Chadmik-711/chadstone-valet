// Supabase Edge Function: notify-pickup
// Sends a Web Push notification to every staff device that opted in, when a
// customer requests their car from the SMS ticket link. Fires even when the
// dashboard isn't open (that's the whole point — the in-app realtime alarm
// already covers open tabs).
//
// Called by ticket.html right after it writes the pickup request:
//   supa.functions.invoke('notify-pickup', { body: { id: <entry uuid> } })
//
// Trust model: the function re-reads the entry via the SERVICE ROLE key, so
// the notification details (bay, plate, ETA) come from the database, not the
// (public) caller. The VAPID private key lives in app_config, readable only
// by the service role — never shipped to the browser.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  let id = "";
  try {
    const body = await req.json();
    id = (body.id ?? "").toString().trim();
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  if (!id) return json({ ok: false, error: "missing 'id'" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  // 1) VAPID keys (private — service role only).
  const { data: cfg, error: cfgErr } = await admin
    .from("app_config").select("value").eq("key", "vapid").maybeSingle();
  if (cfgErr || !cfg?.value?.privateKey) {
    return json({ ok: false, error: "VAPID config missing" }, 500);
  }
  const vapid = cfg.value as { publicKey: string; privateKey: string; subject: string };
  webpush.setVapidDetails(vapid.subject || "mailto:valet@example.com", vapid.publicKey, vapid.privateKey);

  // 2) The entry (trusted details).
  const { data: e } = await admin
    .from("entries")
    .select("ticket,bay,brand,model,rego,time_out,pickup_eta,pickup_source")
    .eq("id", id).maybeSingle();
  if (!e) return json({ ok: false, error: "entry not found" }, 404);
  if (e.time_out) return json({ ok: true, sent: 0, skipped: "already collected" });

  let etaLine = "Customer is ready";
  if (e.pickup_eta) {
    const mins = Math.round((new Date(e.pickup_eta).getTime() - Date.now()) / 60000);
    etaLine = mins <= 0 ? "Customer is here NOW" : `Arriving in about ${mins} min`;
  }
  const car = [e.brand, e.model].filter(Boolean).join(" ") + (e.rego ? ` · ${e.rego}` : "");
  const payload = JSON.stringify({
    title: `🔔 Car requested — Bay ${e.bay ?? "?"}`,
    body: `Ticket ${e.ticket ?? ""} · ${car}\n${etaLine}`,
    tag: `pickup-${id}`,        // collapses duplicate alerts for the same car
    bay: e.bay,
  });

  // 3) All opted-in devices.
  const { data: subs } = await admin
    .from("push_subscriptions").select("id,endpoint,p256dh,auth");
  if (!subs || subs.length === 0) return json({ ok: true, sent: 0 });

  let sent = 0;
  const dead: string[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 600, urgency: "high" },
      );
      sent++;
    } catch (err: any) {
      const code = err?.statusCode;
      // 404/410 = subscription expired or was revoked → drop it.
      if (code === 404 || code === 410) dead.push(s.id);
    }
  }));

  if (dead.length) {
    await admin.from("push_subscriptions").delete().in("id", dead);
  }

  return json({ ok: true, sent, pruned: dead.length });
});
