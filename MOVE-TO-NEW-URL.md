# Moving the Valet app to a new GitHub URL — pre-move checklist

How to copy this web app to a new repo / branded URL **without breaking anything**.

Current live site: `https://chadmik71.github.io/Valet/`
Target example:   `https://chatswoodchasevalet.github.io/`

> The app is fully portable — it has **no hardcoded URLs**, talks to the **same
> Supabase backend** (URL + key live inside `index_v2.html`), and all Edge
> Functions allow any origin (`Access-Control-Allow-Origin: *`). Moving = copying
> the repo. The database does **not** move.

---

## 1. Pick the new account/org name
- The `xxx.github.io` part **must** be a real GitHub username or organisation —
  you can't invent an arbitrary one.
- Recommended: create a free **organisation** named `ChatswoodChaseValet`
  → URL becomes `https://chatswoodchasevalet.github.io/`
- Rules: letters/numbers/hyphens only, no spaces/underscores, max 39 chars.

## 2. Create the new repo
- In the new org, create a repo named **exactly** `ChatswoodChaseValet.github.io`
  (this special name makes it serve at the root URL).
- Leave it empty (no README) so the first push is clean.

## 3. Copy everything across (whole repo, not just the HTML)
```
git clone https://github.com/Chadmik71/Valet.git
cd Valet
git remote add neworigin https://github.com/ChatswoodChaseValet/ChatswoodChaseValet.github.io.git
git push neworigin main
```
This brings every tracked file: `index_v2.html`, `index.html` (root redirect),
`manifest.webmanifest`, `sw.js`, `.nojekyll`, all icons/logos, and the
`supabase/functions/` source.

## 4. Turn on GitHub Pages
- New repo → Settings → Pages → Source: **Deploy from branch** → `main` / root.
- Wait ~30–60s, then open `https://chatswoodchasevalet.github.io/`.
- The root `index.html` auto-redirects to `index_v2.html`, so the clean URL works.

---

## 5. Re-do per-device setup (these do NOT carry to a new domain)
localStorage is per-domain, so on **each device** at the new URL:
- [ ] Log in again (staff session is per-domain).
- [ ] Settings → re-enter the **Square Device ID** (per device).
- [ ] Settings → re-enter the **printer server URL** (BIXOLON/Zebra bridge).
- [ ] Re-install the app ("Add to Home Screen") from the new URL.
- [ ] Re-grant **notification permission** (for pickup alerts).
- [ ] If using auto-save-to-file, re-pick the save location.

Cloud-synced settings (rates, retailers, dashboard layout, handover notes, car-wash
prices, overstay hours, etc.) reload automatically from Supabase — no action needed.

---

## 6. Test the new site BEFORE switching anyone over
Run the full flow on the new URL:
- [ ] Log in.
- [ ] New Entry → check in a **test** car (with and without a bay).
- [ ] Key tag prints (once a bay is set) on the print-station device.
- [ ] SMS QR ticket sends to a phone.
- [ ] Open the QR ticket link — confirm it points to the **new** domain.
- [ ] Checkout → fee calculates, a discount applies, payment status saves.
- [ ] Square Terminal charge completes (sandbox or real).
- [ ] Pickup request raises the alarm / push notification.
- [ ] **Delete the test rows afterwards** — both URLs share the same live
      database, so test check-ins are real data.

---

## 7. Don't break existing tickets
- **Keep the old site live** (`chadmik71.github.io/Valet/`) — QR codes and SMS
  links already given to customers point there.
- Optionally, later: replace the old `index.html`/`index_v2.html` with a redirect
  to the new URL so old links forward automatically.

## 8. Before moving a device off the old site
- [ ] Confirm it's **online and fully synced** (no pending offline writes — those
      live in the old domain's storage and won't migrate).

---

### Why it's safe (verified)
- No file references the old URL (`grep` for `github.io` / `chadmik71` = none).
- Ticket/QR links are built from `location` at runtime (`index_v2.html`).
- Edge functions: all four send `Access-Control-Allow-Origin: *`.
- `manifest.webmanifest` and `sw.js` use relative paths → work at any path/root.
- `index.html` is a relative redirect → clean root URL works automatically.
