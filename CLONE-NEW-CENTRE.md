# Cloning the valet app for a new centre

Each centre runs as its **own separate instance**: its own copy of the app, its
own GitHub Pages site, and its own Supabase project. Data never crosses between
centres. This is the safe, isolated setup — one centre can't see another's cars,
customers, or revenue, and a problem at one site can't touch the other.

Almost everything centre-specific now lives in **one place**: the `★ CENTRE
config` block at the top of the `<script>` in `index_v2.html` (search the file
for `const CENTRE =`). The steps below are the full checklist.

---

## 1. Copy the code into a new repo

1. Copy this whole folder to a new one (or create a new GitHub repo and copy the
   files in). Keep every file — the app is `index_v2.html` plus its images,
   `ticket.html`, `manifest.webmanifest`, `sw.js`, etc.
2. Create a GitHub repo for the new centre and enable **GitHub Pages** on it
   (same as the existing sites). The new centre gets its own URL.

## 2. Create the new centre's Supabase project

The app talks to Supabase for sync, staff login, settings, and audit. A new
centre needs its own project so its data is separate.

1. Create a new Supabase project.
2. Create these **5 tables** (copy the schema from the current project — same
   columns, same RLS policies):
   - `entries` — the valet cars / visits (this is the main table)
   - `staff` — staff logins (with `password_hash`)
   - `app_settings` — synced settings (rates toggles, loyalty config, etc.)
   - `audit_log` — action history
   - `push_subscriptions` — pickup push notifications
   > Easiest path: in the current project use the Supabase dashboard to dump each
   > table's SQL (structure + policies) and run it in the new project. Don't copy
   > the **rows** — a new centre starts empty.
3. Note the new project's **Project URL** and **anon key** (Project Settings →
   API). You'll paste these into the CENTRE block in step 4.

### Edge Functions (deploy all four to the new project)

The functions live in `supabase/functions/`. Deploy each to the new project and
set its secrets (`supabase secrets set NAME=value --project-ref <new-ref>`):

| Function | What it does | Secrets it needs |
|---|---|---|
| `send-ticket-sms` | Texts the QR ticket on check-in | `CLICKSEND_USERNAME`, `CLICKSEND_API_KEY`, `CLICKSEND_SENDER` |
| `square-terminal-checkout` | Card payment on the Square terminal | `SQUARE_ACCESS_TOKEN`, `SQUARE_ENV` (`sandbox` or `production`), optional `SQUARE_VERSION` |
| `identify-vehicle` | Photo → make/model/colour | `ANTHROPIC_API_KEY`, optional `ANTHROPIC_VISION_MODEL` |
| `notify-pickup` | Push notification on pickup | none to set — Supabase provides `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` automatically |

If a centre doesn't use SMS / Square / photo-ID / push, you can skip that
function — the app degrades gracefully.

## 3. Swap the branding image files

Replace these files with the new centre's artwork, **keeping the same
filenames** (the code references them by name, so no code edit is needed):

- `logo-maroon.png`, `logo-gold.png` — the on-screen logos
- `apple-touch-icon.png`, `favicon-16.png`, `favicon-32.png`,
  `icon-192.png`, `icon-512.png`, `icon.svg` — tab/home-screen icons

## 4. Edit the CENTRE config block (the main step)

Open `index_v2.html`, find `const CENTRE =` near the top of the script, and set:

```js
const CENTRE = {
  name:    'New Centre Name',                 // used everywhere as "<name> Valet"
  address: '1 Example St, Suburb NSW 2000',
  phone:   '0400 000 000',
  geo:     { lat: -33.0, lon: 151.0 },        // for weather/holiday demand reports
  valetFee: 20,                               // flat valet fee ($)
  parkingRates: [ /* the centre's time tiers — edit to match its pricing */ ],
  dailyMax: 80,                               // charge beyond the last tier
  supabaseUrl: 'https://<new-ref>.supabase.co',   // from step 2
  supabaseKey: '<new anon key>',                  // from step 2
  salt: 'newcentre-salt-2026',                // any unique string for this centre
  logoMaroon: 'logo-maroon.png',              // leave as-is if you kept filenames
  logoGold:   'logo-gold.png',
};
```

That one block drives: the page title, all printed key-tags, the QR/SMS
messages, every report and CSV header, the parking statement, pricing, weather
reports, and which Supabase project the app syncs to.

> **Pricing note:** the free period (first 2 hrs) and the "beyond last tier"
> cutoff are read from `parkingRates`, but the two threshold numbers `2.0` and
> `7.0` inside `calculateParkingFee()` are still literal. If the new centre's
> free window or number of tiers differs, adjust those two numbers too (search
> for `calculateParkingFee`).

## 5. A few non-CENTRE files to touch (quick)

- **`manifest.webmanifest`** — update `name`, `short_name`, `description`
  (shown when installed as a home-screen app).
- **`<title>` in `index_v2.html`** (line ~6) — the JS overrides the visible tab
  title from `CENTRE.name`, so this only matters for view-source; update if you
  like.
- **`sw.js`** — only a comment mentions the centre; no functional change needed.
- **Settings → Square help text** still shows the old project-ref in its setup
  instructions (search `--project-ref`). Cosmetic; update if it bothers you.

## 6. Per-device setup (done once on each iPad/phone, not in code)

- **Square Device ID** is stored in each device's `localStorage`, not in the
  code — pair each terminal on the device itself via Settings.
- Log in / create the centre's **staff accounts** in the new app (writes to the
  new `staff` table).

## 7. Smoke test before going live

- [ ] App loads, tab title shows the new centre name, logo is correct.
- [ ] Check a test car in → QR/SMS text shows the new centre name + phone.
- [ ] Print a key-tag → header reads `NEW CENTRE NAME VALET`.
- [ ] Check out → parking fee matches the new centre's rates.
- [ ] Open a report → headers/footers show the new name, address, phone.
- [ ] Confirm data lands in the **new** Supabase project (and NOT the old one).
- [ ] If used: Square card payment, photo vehicle-ID, pickup push.

---

*Anything not in the CENTRE block that still says the wrong centre name is a
bug — search the file for the old name and move it into the config.*
