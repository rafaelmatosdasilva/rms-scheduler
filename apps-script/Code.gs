/**
 * RMS Scheduler — Google Apps Script backend
 * ------------------------------------------------------------------
 * Runs AS the calendar owner (no stored credentials).
 *
 *   doGet(?action=availability&days=N)  -> { ok, slots:[ISO...], timeZone, slotMinutes, label }
 *   doPost({ start, name, email, notes, company })
 *                                       -> { ok, eventId } | { ok:false, reason }
 *
 * Deploy: Deploy > New deployment > Web app
 *   - Execute as:   Me
 *   - Who has access: Anyone
 * Then copy the /exec URL into the widget's data-endpoint.
 *
 * NOTE on CORS: Apps Script web apps cannot answer preflight (OPTIONS)
 * or set custom headers. The widget therefore uses only "simple"
 * requests — GET for availability, and POST with a text/plain body for
 * booking — so no preflight is triggered. Do not "fix" the frontend to
 * send application/json; that would break cross-origin booking.
 * ================================================================== */

// ----------------------------- CONFIG ------------------------------
// Edit these to taste. Times are interpreted in the timeZone set in
// appsscript.json (keep them in sync).
var CONFIG = {
  CALENDAR_ID: 'primary',        // 'primary' or a specific calendar id/email
  TIMEZONE: 'Europe/Lisbon',     // MUST match appsscript.json "timeZone"
  SLOT_MINUTES: 30,              // length of each bookable slot
  BUFFER_MINUTES: 0,             // gap enforced around existing events
  LOOKAHEAD_DAYS: 14,            // how far ahead visitors may book
  MIN_NOTICE_MINUTES: 120,       // earliest bookable slot from "now"
  EVENT_TITLE: 'Meeting with {name}',
  EVENT_LOCATION: '',            // optional
  // Business hours per weekday. 0=Sun ... 6=Sat. null = closed that day.
  BUSINESS_HOURS: {
    0: null,
    1: { start: '09:00', end: '17:00' },
    2: { start: '09:00', end: '17:00' },
    3: { start: '09:00', end: '17:00' },
    4: { start: '09:00', end: '17:00' },
    5: { start: '09:00', end: '17:00' },
    6: null
  }
};
// -------------------------------------------------------------------

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'availability';
    if (action !== 'availability') {
      return json_({ ok: false, error: 'unknown action' });
    }
    var days = clampInt_((e && e.parameter && e.parameter.days), CONFIG.LOOKAHEAD_DAYS, 1, CONFIG.LOOKAHEAD_DAYS);
    return json_({
      ok: true,
      timeZone: CONFIG.TIMEZONE,
      slotMinutes: CONFIG.SLOT_MINUTES,
      label: CONFIG.TIMEZONE,
      slots: computeAvailability_(days)
    });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = {};
    try { body = JSON.parse(e.postData.contents); } catch (_) {}

    // Honeypot: real users never fill "company". Pretend success, book nothing.
    if (body.company) return json_({ ok: true, spam: true });

    var name = (body.name || '').toString().trim();
    var email = (body.email || '').toString().trim();
    var notes = (body.notes || '').toString().trim();
    var startIso = (body.start || '').toString().trim();

    if (!name) return json_({ ok: false, reason: 'invalid', message: 'Name is required.' });
    if (!isEmail_(email)) return json_({ ok: false, reason: 'invalid', message: 'A valid email is required.' });

    var start = new Date(startIso);
    if (isNaN(start.getTime())) return json_({ ok: false, reason: 'invalid', message: 'Invalid time.' });

    var now = new Date();
    var minStart = new Date(now.getTime() + CONFIG.MIN_NOTICE_MINUTES * 60000);
    var maxStart = new Date(now.getTime() + CONFIG.LOOKAHEAD_DAYS * 86400000);
    if (start < minStart || start > maxStart) {
      return json_({ ok: false, reason: 'invalid', message: 'That time is no longer bookable.' });
    }

    var end = new Date(start.getTime() + CONFIG.SLOT_MINUTES * 60000);
    var cal = getCalendar_();

    // Re-check the exact slot is still free (guards pick -> submit race).
    if (isBusy_(cal, start, end)) {
      return json_({ ok: false, reason: 'taken', message: 'Sorry, that slot was just booked.' });
    }

    var title = CONFIG.EVENT_TITLE.replace('{name}', name);
    var description = 'Booked via website.\nName: ' + name + '\nEmail: ' + email +
      (notes ? ('\n\nNotes:\n' + notes) : '');

    var event = cal.createEvent(title, start, end, {
      description: description,
      location: CONFIG.EVENT_LOCATION || undefined,
      guests: email,
      sendInvites: true
    });

    return json_({
      ok: true,
      eventId: event.getId(),
      start: Utilities.formatDate(start, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX")
    });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// --------------------------- CORE LOGIC ----------------------------

function computeAvailability_(days) {
  var cal = getCalendar_();
  var now = new Date();
  var earliest = new Date(now.getTime() + CONFIG.MIN_NOTICE_MINUTES * 60000);
  var slots = [];

  var today = new Date();
  today.setHours(0, 0, 0, 0);

  for (var d = 0; d < days; d++) {
    var day = new Date(today.getTime());
    day.setDate(today.getDate() + d);

    var hours = CONFIG.BUSINESS_HOURS[day.getDay()];
    if (!hours) continue;

    var open = atTime_(day, hours.start);
    var close = atTime_(day, hours.end);
    if (!open || !close || close <= open) continue;

    // Fetch the day's events once, then test each candidate slot against them.
    var events = cal.getEvents(open, close).filter(function (ev) {
      return ev.getMyStatus() !== CalendarApp.GuestStatus.NO; // ignore declined
    });

    var cursor = new Date(open.getTime());
    while (cursor.getTime() + CONFIG.SLOT_MINUTES * 60000 <= close.getTime()) {
      var slotStart = new Date(cursor.getTime());
      var slotEnd = new Date(cursor.getTime() + CONFIG.SLOT_MINUTES * 60000);

      if (slotStart >= earliest && !overlapsAny_(events, slotStart, slotEnd)) {
        slots.push(Utilities.formatDate(slotStart, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"));
      }
      cursor = new Date(cursor.getTime() + CONFIG.SLOT_MINUTES * 60000);
    }
  }
  return slots;
}

function isBusy_(cal, start, end) {
  var events = cal.getEvents(start, end).filter(function (ev) {
    return ev.getMyStatus() !== CalendarApp.GuestStatus.NO;
  });
  return overlapsAny_(events, start, end);
}

function overlapsAny_(events, slotStart, slotEnd) {
  var buffer = CONFIG.BUFFER_MINUTES * 60000;
  for (var i = 0; i < events.length; i++) {
    var evStart = events[i].getStartTime().getTime() - buffer;
    var evEnd = events[i].getEndTime().getTime() + buffer;
    if (evStart < slotEnd.getTime() && evEnd > slotStart.getTime()) return true;
  }
  return false;
}

// ---------------------------- HELPERS ------------------------------

function getCalendar_() {
  return CONFIG.CALENDAR_ID === 'primary'
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
}

/** Returns a Date at HH:MM on the given day, in the script timezone. */
function atTime_(day, hhmm) {
  var parts = String(hhmm).split(':');
  if (parts.length !== 2) return null;
  var h = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  var dt = new Date(day.getTime());
  dt.setHours(h, m, 0, 0);
  return dt;
}

function isEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function clampInt_(v, dflt, min, max) {
  var n = parseInt(v, 10);
  if (isNaN(n)) n = dflt;
  return Math.max(min, Math.min(max, n));
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
