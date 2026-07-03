// Supabase Edge Function: identify-vehicle
// Reads a car photo (the same frame the Snap plate-scanner captures) and
// returns the vehicle's Make, Model and Colour using Claude vision. The
// Anthropic API key lives in Supabase secrets, never in the public page.
//
// Request:  { "image": "data:image/jpeg;base64,...." }   (data URL or raw base64)
// Response: { ok, make, model, colour }
//
// Cost is a fraction of a cent per photo (Claude Haiku vision), with no
// minimum spend — far cheaper than a per-lookup rego/NEVDIS API. The client
// caches results by plate so repeat cars never hit this function.
//
// Deploy:
//   supabase functions deploy identify-vehicle --project-ref ebqiitxiyzzbkgyfypss
// Secret (set once):
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxxx --project-ref ebqiitxiyzzbkgyfypss

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
// Cheapest vision-capable Claude model — plenty for make/model/colour.
const MODEL = Deno.env.get("ANTHROPIC_VISION_MODEL") ?? "claude-haiku-4-5-20251001";

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

const PROMPT =
  'Identify the vehicle in this photo. Respond with ONLY strict JSON, no other text: ' +
  '{"make":"","model":"","colour":""}. ' +
  '"make" = manufacturer (e.g. Toyota). "model" = model name only (e.g. Corolla). ' +
  '"colour" = the exterior paint colour in one plain English word (e.g. White, Silver, Black). ' +
  'If a field is not clear from the image, use an empty string. Do not guess wildly.';

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  if (!API_KEY) {
    return json({ ok: false, error: "vehicle ID not configured (missing ANTHROPIC_API_KEY)" }, 503);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const raw = (body.image ?? "").toString();
  if (!raw) return json({ ok: false, error: "missing 'image'" }, 400);
  // Accept a full data URL or bare base64; strip any "data:...;base64," prefix.
  const b64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
  if (!b64) return json({ ok: false, error: "empty image" }, 400);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 120,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error(`[identify-vehicle] anthropic httpOk=false status=${res.status} resp=${JSON.stringify(data)}`);
      return json({ ok: false, error: data?.error?.message ?? `HTTP ${res.status}` }, 502);
    }

    const text = (data?.content?.[0]?.text ?? "").toString();
    let info = { make: "", model: "", colour: "" };
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        info = {
          make: (parsed.make ?? "").toString().trim(),
          model: (parsed.model ?? "").toString().trim(),
          colour: (parsed.colour ?? "").toString().trim(),
        };
      }
    } catch { /* leave info blank if the model didn't return clean JSON */ }

    console.log(`[identify-vehicle] ok make=${info.make} model=${info.model} colour=${info.colour}`);
    return json({ ok: true, ...info });
  } catch (e) {
    console.error(`[identify-vehicle] FETCH ERROR ${String(e)}`);
    return json({ ok: false, error: String(e) }, 502);
  }
});
