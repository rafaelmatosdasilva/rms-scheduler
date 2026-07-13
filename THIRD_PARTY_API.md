# In-person booking API

Read-only availability + booking for **in-person sessions only**. No API key, no auth —
these are public endpoints backed by a Google Apps Script web app.

Base URL:
```
https://script.google.com/macros/s/AKfycbxWJC_Y2T37JZIvZszOQw9akjr3PbOKsfIkVzJCrweSioxoYfXzoolv_4y8phA8hxcTIw/exec
```

## 1. List available in-person slots

```
GET {base}?action=inperson-availability
```

**Response**
```json
{
  "ok": true,
  "timeZone": "Europe/Lisbon",
  "slots": [
    { "start": "2026-07-10T10:00:00+01:00", "end": "2026-07-10T10:45:00+01:00" },
    { "start": "2026-07-10T11:00:00+01:00", "end": "2026-07-10T11:45:00+01:00" }
  ]
}
```
- `start` / `end` are ISO 8601 with the UTC offset already applied (`timeZone` is given for display only).
- This endpoint **only ever returns in-person slots** — online slots and anything else are never included.
- Cached ~3 minutes server-side; poll it as often as you like.

```sh
curl "{base}?action=inperson-availability"
```

## 2. Book a slot

```
POST {base}?action=book-inperson
Content-Type: text/plain;charset=utf-8
```
> Must be sent as `text/plain`, not `application/json` — this avoids a CORS preflight that
> Apps Script can't answer. The body is still JSON text; just don't set the JSON content-type header.

**Body**
```json
{
  "start": "2026-07-10T10:00:00+01:00",
  "name": "Guest Name",
  "email": "guest@example.com",
  "notes": "What they'd like to cover",
  "ticket": true
}
```

| field   | required | notes |
|---------|----------|-------|
| `start` | yes      | must exactly match a `start` from the availability list above |
| `name`  | yes      | |
| `email` | yes      | must be a valid email — a calendar invite is sent here |
| `notes` | no       | freeform, shown in the event description |
| `ticket`| **yes**  | must be `true` — confirms the guest has a valid LisboaUX co-working day ticket |

**Success**
```json
{
  "ok": true,
  "eventId": "…",
  "type": "inperson",
  "start": "2026-07-10T10:00:00+01:00",
  "end": "2026-07-10T10:45:00+01:00"
}
```

**Failure** (`ok: false`) — one of:
| `reason` | when |
|---|---|
| `invalid` | missing/invalid `name`/`email`/`start`, missing `ticket`, or the slot isn't an in-person slot |
| `taken`   | the slot is no longer available (already booked, or too soon/too far out) |

On `reason: "taken"`, re-fetch the availability list — the slot is gone.

```sh
curl -X POST "{base}?action=book-inperson" \
  -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"start":"2026-07-10T10:00:00+01:00","name":"Guest Name","email":"guest@example.com","notes":"...","ticket":true}'
```

## Guarantees

- `book-inperson` **only ever books in-person slots** — passing the start time of an online slot
  is rejected. Online availability/bookings are not reachable through this API at all.
- Double-booking is prevented server-side: the slot is re-verified at booking time even if two
  people try to book it at once.
- The guest's email receives a calendar invite with the in-person address and a Google Maps
  directions link. No Google Meet link is ever attached to in-person bookings.

## Rate limits / reliability

- No published rate limit on availability; keep polling to a reasonable interval (once every
  30–60s is plenty — responses are cached).
- Booking is capped per email address (a rolling limit); once exceeded, `POST` returns
  `{ "ok": false, "reason": "rate", "message": "…" }`. Treat `reason: "rate"` as non-retryable.
- Apps Script occasionally returns a transient error on a request; treat any non-2xx or network
  error as retryable and retry once or twice with a short delay before surfacing a failure.
