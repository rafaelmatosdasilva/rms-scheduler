# RMS Scheduler

A tiny, embeddable booking widget for your website. Visitors pick an open time
slot and a real event is created on **your** Google Calendar — with a fully
custom UI you control.

**How availability works:** you keep a dedicated **Availability calendar** and drop
an event on it wherever you're free to take a call. **Each event = one bookable
slot, and its length is the call length** — draw a 30-min event for a 30-min call,
a 45-min one for 45. When a visitor books, the appointment (with their invite) is
written to your **Booking calendar** and the availability event is consumed so it
can't be booked twice. Slots also auto-hide if anything on your *other* calendars
conflicts, so you can't be double-booked.

- **Frontend:** one plain HTML/JS snippet (`docs/scheduler.js` + `scheduler.css`), hosted free on **GitHub Pages**.
- **Backend:** a free **Google Apps Script** web app (`apps-script/Code.gs`) that runs *as you* via `CalendarApp` — **no paid host, no service account, no stored credentials.**

```
GitHub Pages (static)                 Google (free, runs as you)
┌──────────────────────────┐  fetch  ┌────────────────────────────┐
│ scheduler.js (widget)    │ ──────▶ │ Apps Script Web App        │
│  • fetch open slots      │         │  doGet  → availability     │
│  • visitor picks + form  │ ◀────── │  doPost → create event     │
└──────────────────────────┘  JSON   └────────────────────────────┘
```

---

## 1. Deploy the backend (Google Apps Script)

1. Go to <https://script.google.com> → **New project**.
2. Open **Project Settings** (gear) → tick **“Show `appsscript.json` manifest file in editor.”**
3. Replace the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs), and
   `appsscript.json` with [`apps-script/appsscript.json`](apps-script/appsscript.json).
4. Create a dedicated **Availability** calendar (Google Calendar → *Other calendars*
   → **＋ → Create new calendar**), then open its **Settings → Integrate calendar**
   and copy its **Calendar ID**.
5. Edit the `CONFIG` block at the top of `Code.gs`:
   - `AVAILABILITY_CALENDAR_ID` — the Calendar ID from the step above (where you mark slots).
   - `BOOKING_CALENDAR_ID` — `'primary'` for your main calendar, or a specific calendar id.
   - `TIMEZONE` — your IANA zone (**must match** `timeZone` in `appsscript.json`).
   - `LOOKAHEAD_DAYS`, `MIN_NOTICE_MINUTES`, `BUFFER_MINUTES`, `CONSUME_SLOT`.
5. **Deploy → New deployment → Web app**:
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`
   - Click **Deploy**, then **Authorize access** and grant the Calendar permission.
   > Google will warn the app is “unverified” because it’s your own script — click
   > *Advanced → Go to (project)* to continue. It only ever touches your calendar.
6. Copy the **Web app URL** (ends in `/exec`).

**Test the backend directly:** add some events to your Availability calendar, then
paste `<your-exec-url>?action=availability` into a browser. You should see JSON like
`{"ok":true,"slots":[{"start":"2026-07-06T10:00:00+01:00","end":"2026-07-06T10:30:00+01:00"}, ...]}`.

> Re-deploy note: after editing `Code.gs`, use **Deploy → Manage deployments → Edit → Version:
> New version** so the live `/exec` URL picks up your changes (the URL stays the same).

---

## 2. Publish the frontend (GitHub Pages)

1. Push this repo to GitHub.
2. **Settings → Pages → Build and deployment → Source:** *Deploy from a branch*,
   **Branch:** `main` / **folder:** `/docs`.
3. Your widget will be live at `https://YOUR-USERNAME.github.io/rms-scheduler/scheduler.js`.
4. Edit `docs/index.html` and set `data-endpoint` to your `/exec` URL to see the live demo.

---

## 3. Embed on your website

```html
<div id="rms-scheduler"></div>
<script
  src="https://YOUR-USERNAME.github.io/rms-scheduler/scheduler.js"
  data-endpoint="https://script.google.com/macros/s/XXXX/exec"
  data-title="Book a time with me"></script>
```

**Optional `<script>` attributes:** `data-mount` (CSS selector, default `#rms-scheduler`),
`data-title`, `data-css` (override stylesheet URL).

**Re-theme** by overriding the CSS variables on the container:

```css
#rms-scheduler {
  --rmssch-accent: #e5484d;
  --rmssch-radius: 16px;
  --rmssch-font: "Inter", sans-serif;
}
```

---

## How it works / notes

- **No credentials to leak:** the widget calls your Apps Script URL, which runs with *your*
  Google permissions. Nothing secret ships to the browser.
- **CORS:** Apps Script web apps can’t answer preflight requests. The widget deliberately uses
  only “simple” requests — a **GET** for availability and a **POST with `text/plain`** body for
  booking — so no preflight is triggered. **Don’t change the frontend to send
  `application/json`**; it would break cross-origin booking.
- **Double-booking:** at booking time the backend re-confirms the availability event still
  exists and that nothing on your other calendars conflicts, then consumes the slot
  (`CONSUME_SLOT`) so it can't be booked again.
- **Spam:** a hidden honeypot field plus server-side validation (email format, future-only,
  within lookahead). Apps Script’s free quotas comfortably cover personal-site traffic.
- **Guest invites:** the visitor is added as a guest with `sendInvites: true`, so they receive a
  Google Calendar invite. If invite emails ever prove unreliable on a personal account, the
  fallback is an OAuth-refresh-token backend — but that reintroduces credential storage, which is
  exactly what this design avoids.

## Files

| Path | Purpose |
|------|---------|
| `apps-script/Code.gs` | Backend: availability + booking, all config at the top |
| `apps-script/appsscript.json` | Apps Script manifest (timezone, Calendar scope, web-app config) |
| `docs/scheduler.js` | The embeddable widget |
| `docs/scheduler.css` | Widget styles (prefixed `.rmssch-*`, CSS-variable themed) |
| `docs/index.html` | Live demo + copy-paste embed snippet |
