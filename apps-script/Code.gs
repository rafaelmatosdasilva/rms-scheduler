/**
 * RMS Scheduler — Google Apps Script backend
 * ------------------------------------------------------------------
 * Runs AS the calendar owner (no stored credentials).
 *
 * MODEL: you define availability by creating events on a dedicated
 * "Availability" calendar. Each event = ONE bookable slot; its length
 * is the call length. When a visitor books, the appointment is written
 * to your BOOKING calendar (with a guest invite) and the availability
 * event is consumed so it can't be booked twice.
 *
 *   doGet(?action=availability&days=N)
 *       -> { ok, timeZone, label, slots:[{start,end}...] }
 *   doPost({ start, name, email, notes, company })
 *       -> { ok, eventId } | { ok:false, reason }
 *
 * Deploy: Deploy > New deployment > Web app
 *   - Execute as:   Me
 *   - Who has access: Anyone
 * After ANY code change, re-deploy a NEW VERSION:
 *   Deploy > Manage deployments > edit (pencil) > Version: New version.
 *
 * NOTE on CORS: Apps Script web apps cannot answer preflight (OPTIONS)
 * or set custom headers. The widget therefore uses only "simple"
 * requests — GET for availability, and POST with a text/plain body for
 * booking — so no preflight is triggered. Do not "fix" the frontend to
 * send application/json; that would break cross-origin booking.
 * ================================================================== */

// ----------------------------- CONFIG ------------------------------
var CONFIG = {
  // Dedicated calendar where YOU create events to mark bookable slots.
  // Each event becomes one offerable appointment (its duration = call length).
  AVAILABILITY_CALENDAR_ID: 'c_b4f6f948e96d142d1a632ea961e94715ea838de13579dc63bbb272a8a87c247c@group.calendar.google.com',

  // Calendar that confirmed bookings are written to (with the guest invite).
  BOOKING_CALENDAR_ID: 'c_6fcad1e1845ac5b311edec0bd7b5ccc072849f2d71a687a78ad0eb51a5fc8fde@group.calendar.google.com',

  TIMEZONE: 'Europe/Lisbon',        // MUST match appsscript.json "timeZone"
  LOOKAHEAD_DAYS: 30,               // how far ahead slots are offered
  MIN_NOTICE_MINUTES: 120,          // earliest bookable slot from "now"
  BUFFER_MINUTES: 0,                // gap enforced around conflicting events
  CONSUME_SLOT: true,               // delete the availability event once booked
  CACHE_SECONDS: 45,                // cache availability this long (speeds loads)

  EVENT_TITLE: 'Meeting with {name}',
  EVENT_LOCATION: ''                // optional
};
// -------------------------------------------------------------------

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'availability';
    if (action !== 'availability') return json_({ ok: false, error: 'unknown action' });
    var days = clampInt_((e && e.parameter && e.parameter.days), CONFIG.LOOKAHEAD_DAYS, 1, CONFIG.LOOKAHEAD_DAYS);

    // Short cache so repeat loads are instant. Booking clears it (see doPost);
    // and a slot booked within the window is caught by the re-check in doPost.
    var cache = CacheService.getScriptCache();
    var key = 'avail_' + days;
    var hit = cache.get(key);
    if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);

    var payload = JSON.stringify({
      ok: true, timeZone: CONFIG.TIMEZONE, label: CONFIG.TIMEZONE, slots: computeAvailability_(days)
    });
    cache.put(key, payload, CONFIG.CACHE_SECONDS);
    return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = {};
    try { body = JSON.parse(e.postData.contents); } catch (_) {}

    // Honeypot: real users never fill this hidden field. Pretend success, book
    // nothing. (Named hp_check, not "company", so browser autofill won't trip it.)
    if (body.hp) return json_({ ok: true, spam: true });

    var name = (body.name || '').toString().trim();
    var email = (body.email || '').toString().trim();
    var notes = (body.notes || '').toString().trim();
    var startIso = (body.start || '').toString().trim();

    if (!name) return json_({ ok: false, reason: 'invalid', message: 'Name is required.' });
    if (!isEmail_(email)) return json_({ ok: false, reason: 'invalid', message: 'A valid email is required.' });

    var start = new Date(startIso);
    if (isNaN(start.getTime())) return json_({ ok: false, reason: 'invalid', message: 'Invalid time.' });

    var now = new Date();
    if (start < new Date(now.getTime() + CONFIG.MIN_NOTICE_MINUTES * 60000) ||
        start > new Date(now.getTime() + CONFIG.LOOKAHEAD_DAYS * 86400000)) {
      return json_({ ok: false, reason: 'taken', message: 'That time is no longer bookable.' });
    }

    // The slot must still exist on the availability calendar. This also gives
    // us the authoritative end time (visitors can't tamper with duration).
    var slotEvent = findAvailabilityEvent_(start);
    if (!slotEvent) return json_({ ok: false, reason: 'taken', message: 'Sorry, that slot is no longer available.' });
    var end = slotEvent.getEndTime();

    // Re-check nothing else on your calendars now conflicts.
    if (isBusy_(start, end)) return json_({ ok: false, reason: 'taken', message: 'Sorry, that slot was just taken.' });

    var title = CONFIG.EVENT_TITLE.replace('{name}', name);
    var description = 'Booked via website.\nName: ' + name + '\nEmail: ' + email +
      (notes ? ('\n\nNotes:\n' + notes) : '');

    var event = getBookingCalendar_().createEvent(title, start, end, {
      description: description,
      location: CONFIG.EVENT_LOCATION || undefined,
      guests: email,
      sendInvites: true
    });

    // Consume the availability slot so it can't be booked again.
    if (CONFIG.CONSUME_SLOT) { try { slotEvent.deleteEvent(); } catch (_) {} }

    // Invalidate the availability cache so the booked slot disappears at once.
    try { CacheService.getScriptCache().remove('avail_' + CONFIG.LOOKAHEAD_DAYS); } catch (_) {}

    return json_({
      ok: true,
      eventId: event.getId(),
      start: Utilities.formatDate(start, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      end: Utilities.formatDate(end, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX")
    });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// --------------------------- CORE LOGIC ----------------------------

function computeAvailability_(days) {
  var now = new Date();
  var earliest = new Date(now.getTime() + CONFIG.MIN_NOTICE_MINUTES * 60000);
  var horizon = new Date(now.getTime() + days * 86400000);

  var events = getAvailabilityCalendar_().getEvents(now, horizon);
  // Fetch busy events from every other owned calendar ONCE over the whole
  // window, then test overlaps in memory (avoids a query per slot).
  var busy = collectBusy_(now, horizon);
  var slots = [];
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (ev.isAllDayEvent()) continue;            // all-day events aren't slots
    var s = ev.getStartTime();
    var e = ev.getEndTime();
    if (s < earliest) continue;                  // too soon / in the past
    if (overlapsBusy_(busy, s, e)) continue;     // conflicts elsewhere -> hide
    slots.push({
      start: Utilities.formatDate(s, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      end: Utilities.formatDate(e, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      type: slotType_(ev.getTitle())   // 'online' | 'inperson' | ''
    });
  }
  return slots;
}

/** Classify a slot from its availability-event title. */
function slotType_(title) {
  var t = (title || '').toLowerCase();
  if (/in.?person|presencial|presencial|in-person/.test(t)) return 'inperson';
  if (/online|remote|meet|zoom|call|virtual/.test(t)) return 'online';
  return '';
}

/** Busy intervals [startMs, endMs] (buffer-expanded) across all busy calendars. */
function collectBusy_(start, end) {
  var buffer = CONFIG.BUFFER_MINUTES * 60000;
  var cals = getBusyCalendars_();
  var out = [];
  for (var i = 0; i < cals.length; i++) {
    var evs = cals[i].getEvents(start, end);
    for (var j = 0; j < evs.length; j++) {
      if (evs[j].getMyStatus() === CalendarApp.GuestStatus.NO) continue;
      out.push([evs[j].getStartTime().getTime() - buffer, evs[j].getEndTime().getTime() + buffer]);
    }
  }
  return out;
}

function overlapsBusy_(busy, s, e) {
  var ss = s.getTime(), ee = e.getTime();
  for (var i = 0; i < busy.length; i++) {
    if (busy[i][0] < ee && busy[i][1] > ss) return true;
  }
  return false;
}

/** The availability event that starts exactly at `start`, or null. */
function findAvailabilityEvent_(start) {
  var evs = getAvailabilityCalendar_().getEvents(start, new Date(start.getTime() + 60000));
  for (var i = 0; i < evs.length; i++) {
    if (!evs[i].isAllDayEvent() && Math.abs(evs[i].getStartTime().getTime() - start.getTime()) < 1000) {
      return evs[i];
    }
  }
  return null;
}

/**
 * True if any calendar you own (EXCEPT the availability calendar, whose
 * events are offers rather than commitments) has a non-declined event
 * overlapping [start, end), expanded by BUFFER_MINUTES.
 */
function isBusy_(start, end) {
  var buffer = CONFIG.BUFFER_MINUTES * 60000;
  var cals = getBusyCalendars_();
  for (var i = 0; i < cals.length; i++) {
    var evs = cals[i].getEvents(new Date(start.getTime() - buffer), new Date(end.getTime() + buffer));
    for (var j = 0; j < evs.length; j++) {
      var ev = evs[j];
      if (ev.getMyStatus() === CalendarApp.GuestStatus.NO) continue; // declined
      var es = ev.getStartTime().getTime() - buffer;
      var ee = ev.getEndTime().getTime() + buffer;
      if (es < end.getTime() && ee > start.getTime()) return true;
    }
  }
  return false;
}

// ---------------------------- HELPERS ------------------------------

var _availabilityCal = null, _bookingCal = null, _busyCals = null;

function getAvailabilityCalendar_() {
  if (!_availabilityCal) _availabilityCal = CalendarApp.getCalendarById(CONFIG.AVAILABILITY_CALENDAR_ID);
  if (!_availabilityCal) throw new Error('Availability calendar not found: ' + CONFIG.AVAILABILITY_CALENDAR_ID);
  return _availabilityCal;
}

function getBookingCalendar_() {
  if (!_bookingCal) {
    _bookingCal = CONFIG.BOOKING_CALENDAR_ID === 'primary'
      ? CalendarApp.getDefaultCalendar()
      : CalendarApp.getCalendarById(CONFIG.BOOKING_CALENDAR_ID);
  }
  return _bookingCal;
}

/** All owned calendars except the availability calendar. Cached per run. */
function getBusyCalendars_() {
  if (_busyCals) return _busyCals;
  var availId = getAvailabilityCalendar_().getId();
  _busyCals = CalendarApp.getAllOwnedCalendars().filter(function (c) { return c.getId() !== availId; });
  return _busyCals;
}

function isEmail_(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }

function clampInt_(v, dflt, min, max) {
  var n = parseInt(v, 10);
  if (isNaN(n)) n = dflt;
  return Math.max(min, Math.min(max, n));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ------------------------- KEEP-WARM (optional) --------------------
// Apps Script web apps go "cold" after a few idle minutes, making the next
// request slow. Run setupKeepWarm() ONCE from the editor (press Run, then
// authorize) to create a trigger that pings the web app every 5 minutes so it
// stays warm. Run removeKeepWarm() to stop it.

function keepWarm() {
  try {
    var url = ScriptApp.getService().getUrl();
    if (url) UrlFetchApp.fetch(url + '?action=availability&warm=1', { muteHttpExceptions: true });
  } catch (err) {}
}

function setupKeepWarm() {
  removeKeepWarm();
  ScriptApp.newTrigger('keepWarm').timeBased().everyMinutes(5).create();
}

function removeKeepWarm() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'keepWarm') ScriptApp.deleteTrigger(t);
  });
}
