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

  // Calendars checked for conflicts when offering slots (a slot is hidden if you
  // are busy then). Scanning EVERY owned calendar is slow on accounts with many
  // calendars, so default to your main calendar only. Add specific calendar IDs
  // here if your real commitments live on other calendars.
  BUSY_CALENDAR_IDS: ['primary'],

  TIMEZONE: 'Europe/Lisbon',        // MUST match appsscript.json "timeZone"
  LOOKAHEAD_DAYS: 30,               // how far ahead slots are offered
  MIN_NOTICE_MINUTES: 2880,         // default notice (48h) — applies to online/other slots
  MIN_NOTICE_MINUTES_INPERSON: 600, // in-person slots only need 10h notice
  BUFFER_MINUTES: 0,                // gap enforced around conflicting events
  // Delete the availability event on booking so the slot is removed at the source.
  // doPost claims the slot (delete-first) inside a script lock, and the booking
  // calendar is included in the busy-check, so a slot isn't double-booked. To
  // re-open a slot after a cancellation, re-add it to the calendar.
  CONSUME_SLOT: true,
  CACHE_SECONDS: 180,               // 3 min safety margin — keep-warm (every 1 min) and the
                                    // calendar-edit trigger both refresh this cache well
                                    // before it would expire on its own. Booking clears it.

  // {first} = booker's first name; {name} = full name.
  EVENT_TITLE: 'Meeting with {name}',   // fallback when a slot's type is unknown
  EVENT_TITLE_ONLINE: 'Online session: Rafael and {first}',
  EVENT_TITLE_INPERSON: 'In-person session: Rafael and {first}',
  EVENT_LOCATION: '',               // optional default location (any slot)

  // Online slots ("online" in the calendar-event title) get a Google Meet link.
  // In-person slots ("in person" in the title) get this physical address.
  // NOTE: Meet links require the advanced "Google Calendar API" service enabled
  // in the Apps Script editor (Services + -> Google Calendar API). If it isn't
  // enabled the booking still succeeds — just without the Meet link.
  // Email YOU (the host) whenever a booking is made — the guest gets a calendar
  // invite, but as the event organizer you otherwise receive no notification.
  // NOTIFY_EMAIL '' defaults to the script owner's address (the deploying user).
  NOTIFY_ON_BOOKING: true,
  NOTIFY_EMAIL: 'hello@rafaelmatosdasilva.com',

  ADD_MEET_FOR_ONLINE: true,
  IN_PERSON_LOCATION: 'Casa do Impacto, Lisbon',
  // Optional Google Maps link appended to the in-person event location so the
  // invite gives the guest tap-to-navigate directions. Leave '' to omit.
  IN_PERSON_MAPS_URL: 'https://maps.app.goo.gl/CjzG7Z5dszL3TsD5A'
};
// -------------------------------------------------------------------

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'availability';
    if (action !== 'availability' && action !== 'inperson-availability') {
      return json_({ ok: false, error: 'unknown action' });
    }
    var days = clampInt_((e && e.parameter && e.parameter.days), CONFIG.LOOKAHEAD_DAYS, 1, CONFIG.LOOKAHEAD_DAYS);

    // Short cache so repeat loads are instant. Booking clears it (see doPost);
    // and a slot booked within the window is caught by the re-check in doPost.
    // ?refresh=1 bypasses the cache entirely and recomputes fresh from the
    // calendar right now — use it to force an update or to sanity-check whether
    // the widget is showing stale cache vs. a deeper compute issue.
    var forceRefresh = (e && e.parameter && e.parameter.refresh) ? true : false;
    var cache = CacheService.getScriptCache();
    var key = 'avail_' + days;
    var hit = forceRefresh ? null : cache.get(key);
    var payload = hit;
    if (!payload) {
      // Read-only compute on the public path: never mutate the calendar in
      // response to an anonymous GET. Expired-slot deletion happens only on the
      // trusted refresh path (refreshAvailabilityCache_, driven by keep-warm and
      // the calendar-edit trigger).
      payload = JSON.stringify({
        ok: true, timeZone: CONFIG.TIMEZONE, label: CONFIG.TIMEZONE, slots: computeAvailability_(days, false)
      });
      cache.put(key, payload, CONFIG.CACHE_SECONDS);
    }

    // Dedicated, scoped endpoint: ALWAYS returns only in-person slots, no matter
    // what params are passed — safe to hand to a third party without exposing
    // online slots or anything else.
    if (action === 'inperson-availability') {
      var full = JSON.parse(payload);
      var onlyInPerson = (full.slots || []).filter(function (s) { return s.type === 'inperson'; })
        .map(function (s) { return { start: s.start, end: s.end }; });
      return json_({ ok: true, timeZone: full.timeZone, slots: onlyInPerson });
    }

    return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    console.error('doGet failed: ' + err);
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = {};
    try { body = JSON.parse(e.postData.contents); } catch (_) {}

    // action=book (default, used by the widget) books any slot type.
    // action=book-inperson is a scoped booking endpoint for 3rd-party integrations:
    // it ONLY succeeds for in-person slots, and requires the ticket confirmation
    // (the widget enforces this via its checkbox; a direct API caller must send it).
    var action = (e && e.parameter && e.parameter.action) || 'book';
    if (action !== 'book' && action !== 'book-inperson') {
      return json_({ ok: false, error: 'unknown action' });
    }

    // Honeypot: real users never fill this hidden field. Pretend success, book
    // nothing. (Named hp_check, not "company", so browser autofill won't trip it.)
    if (body.hp) return json_({ ok: true, spam: true });

    var name = (body.name || '').toString().trim();
    var email = (body.email || '').toString().trim();
    var notes = (body.notes || '').toString().trim();
    var startIso = (body.start || '').toString().trim();
    // Optional useful links (portfolio, resume, …). Trim, drop blanks, cap at 10.
    var links = (Array.isArray(body.links) ? body.links : [])
      .map(function (l) { return (l || '').toString().trim(); })
      .filter(Boolean)
      .slice(0, 10);

    if (!name) return json_({ ok: false, reason: 'invalid', message: 'Name is required.' });
    if (!isEmail_(email)) return json_({ ok: false, reason: 'invalid', message: 'A valid email is required.' });

    var start = new Date(startIso);
    if (isNaN(start.getTime())) return json_({ ok: false, reason: 'invalid', message: 'Invalid time.' });

    var now = new Date();
    if (start > new Date(now.getTime() + CONFIG.LOOKAHEAD_DAYS * 86400000)) {
      return json_({ ok: false, reason: 'taken', message: 'That time is no longer bookable.' });
    }

    // Serialize the check -> claim -> create section. Apps Script runs doPost
    // concurrently with no auto-locking, so without this two overlapping POSTs
    // for the same slot could both pass the checks below and both send an invite.
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
    } catch (lockErr) {
      return json_({ ok: false, reason: 'taken', message: 'Sorry, that slot was just taken.' });
    }
    try {
      // The slot must still exist on the availability calendar. This also gives
      // us the authoritative end time (visitors can't tamper with duration).
      var slotEvent = findAvailabilityEvent_(start);
      if (!slotEvent) return json_({ ok: false, reason: 'taken', message: 'Sorry, that slot is no longer available.' });
      var slotTitle = slotEvent.getTitle();
      var end = slotEvent.getEndTime();
      var type = slotType_(slotTitle);   // 'online' | 'inperson' | ''

      // Notice window depends on slot type (in-person needs less lead time).
      if (start < new Date(now.getTime() + noticeMinutesForType_(type) * 60000)) {
        return json_({ ok: false, reason: 'taken', message: 'That time is no longer bookable.' });
      }

      // Re-check nothing else on your calendars now conflicts (this includes the
      // booking calendar, so an existing confirmed booking blocks the slot too).
      if (isBusy_(start, end)) return json_({ ok: false, reason: 'taken', message: 'Sorry, that slot was just taken.' });

      if (action === 'book-inperson' && type !== 'inperson') {
        return json_({ ok: false, reason: 'invalid', message: 'This endpoint only books in-person slots.' });
      }
      if (type === 'inperson' && !body.ticket) {
        return json_({ ok: false, reason: 'invalid', message: 'A valid LisboaUX co-working day ticket is required.' });
      }

      // Claim the slot FIRST by deleting the source availability event, so the
      // time is atomically reserved before the booking is written. If the delete
      // fails (transient Calendar error), abort rather than confirm a booking on
      // a still-live slot — otherwise the next visitor could book the same time.
      if (CONFIG.CONSUME_SLOT) {
        var consumed = false;
        for (var attempt = 0; attempt < 2 && !consumed; attempt++) {
          try { slotEvent.deleteEvent(); consumed = true; } catch (delErr) {}
        }
        if (!consumed) return json_({ ok: false, reason: 'taken', message: 'Sorry, that slot was just taken.' });
      }

      var first = (name || '').trim().split(/\s+/)[0] || name;
      var titleTpl = (type === 'inperson' && CONFIG.EVENT_TITLE_INPERSON) ? CONFIG.EVENT_TITLE_INPERSON
        : (type === 'online' && CONFIG.EVENT_TITLE_ONLINE) ? CONFIG.EVENT_TITLE_ONLINE
        : CONFIG.EVENT_TITLE;
      var title = titleTpl.replace('{name}', name).replace('{first}', first);
      var description = 'Name: ' + name + '\nEmail: ' + email +
        (notes ? ('\n\nNotes:\n' + notes) : '') +
        (links.length ? ('\n\nLinks:\n' + links.map(function (l) { return '- ' + l; }).join('\n')) : '');

      var event;
      try {
        event = createBooking_(title, description, start, end, email, type);
      } catch (bookErr) {
        // Booking write failed after the slot was consumed — restore the slot so
        // it isn't silently lost, then surface the error.
        console.error('booking write failed: ' + bookErr);
        if (CONFIG.CONSUME_SLOT) {
          try { getAvailabilityCalendar_().createEvent(slotTitle, start, end); }
          catch (restoreErr) { console.error('slot restore failed after booking error: ' + restoreErr); }
        }
        return json_({ ok: false, error: String(bookErr) });
      }

      // Notify the host (the guest already gets the calendar invite). Never let a
      // mail failure break a confirmed booking.
      if (CONFIG.NOTIFY_ON_BOOKING) {
        try { notifyHost_({ name: name, email: email, notes: notes, links: links, type: type, start: start, end: end, meetLink: event.hangoutLink || '' }); }
        catch (mailErr) { console.error('host notification failed: ' + mailErr); }
      }

      // Invalidate the availability cache so the booked slot disappears at once.
      // doGet caches per ?days= value, so clear every possible key, not just the
      // default — otherwise a ?days=N request keeps serving the booked slot.
      try { CacheService.getScriptCache().removeAll(availCacheKeys_()); } catch (cacheErr) { console.error('cache clear failed: ' + cacheErr); }

      return json_({
        ok: true,
        eventId: event.id || (event.getId && event.getId()),
        meetLink: event.hangoutLink || '',
        type: type,
        start: Utilities.formatDate(start, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"),
        end: Utilities.formatDate(end, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX")
      });
    } finally {
      try { lock.releaseLock(); } catch (_) {}
    }
  } catch (err) {
    console.error('doPost failed: ' + err);
    return json_({ ok: false, error: String(err) });
  }
}

// --------------------------- CORE LOGIC ----------------------------

// Minimum notice for a given slot type — in-person needs less lead time than
// online/other slots (CONFIG.MIN_NOTICE_MINUTES_INPERSON vs. MIN_NOTICE_MINUTES).
function noticeMinutesForType_(type) {
  return (type === 'inperson' && CONFIG.MIN_NOTICE_MINUTES_INPERSON != null)
    ? CONFIG.MIN_NOTICE_MINUTES_INPERSON : CONFIG.MIN_NOTICE_MINUTES;
}

// allowDelete: when true, availability events that have fallen inside their
// notice window are removed from the calendar as they're encountered. Only the
// trusted refresh path passes true; the public GET path passes false so an
// anonymous request can never trigger calendar writes.
function computeAvailability_(days, allowDelete) {
  var now = new Date();
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
    var type = slotType_(ev.getTitle());          // 'online' | 'inperson' | ''
    var earliest = new Date(now.getTime() + noticeMinutesForType_(type) * 60000);
    if (s < earliest) {                          // too soon / in the past
      // Once a slot falls inside its notice window it can never be booked again,
      // so remove it from the calendar (on the trusted refresh path only) instead
      // of waiting for the hourly cleanup — keeps the calendar in sync with the
      // widget without letting an anonymous GET trigger deletions.
      if (allowDelete) { try { ev.deleteEvent(); } catch (delErr) { console.error('slot delete failed: ' + delErr); } }
      continue;
    }
    if (overlapsBusy_(busy, s, e)) continue;     // conflicts elsewhere -> hide
    slots.push({
      start: Utilities.formatDate(s, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      end: Utilities.formatDate(e, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      type: type
    });
  }
  return slots;
}

/** Classify a slot from its availability-event title. */
function slotType_(title) {
  var t = (title || '').toLowerCase();
  if (/in.?person|presencial/.test(t)) return 'inperson';
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

/**
 * Create the booking event. Online slots get a Google Meet link (via the
 * advanced Calendar service, if enabled); in-person slots get the configured
 * address. Falls back to CalendarApp when Meet isn't needed/available.
 */
function createBooking_(title, description, start, end, email, type) {
  var location;
  if (type === 'inperson') {
    location = 'In-person at ' + (CONFIG.IN_PERSON_LOCATION || CONFIG.EVENT_LOCATION);
    if (CONFIG.IN_PERSON_MAPS_URL) location += ' - ' + CONFIG.IN_PERSON_MAPS_URL;
  } else {
    location = CONFIG.EVENT_LOCATION;
  }
  var wantsMeet = (type === 'online') && CONFIG.ADD_MEET_FOR_ONLINE;

  // Use the advanced Calendar API whenever it's available so we fully control
  // conferencing. Meet is added ONLY for online slots; for everything else we
  // insert without conferenceData and then strip any Meet link Google may have
  // auto-attached (the account's "automatically add Google Meet" setting).
  if (typeof Calendar !== 'undefined' && Calendar.Events) {
    var resource = {
      summary: title,
      description: description,   // plain text; Google auto-links URLs in the invite
      location: location || undefined,
      start: { dateTime: iso_(start), timeZone: CONFIG.TIMEZONE },
      end: { dateTime: iso_(end), timeZone: CONFIG.TIMEZONE },
      attendees: [{ email: email }]
    };
    if (wantsMeet) {
      resource.conferenceData = { createRequest: { requestId: Utilities.getUuid(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
    }
    var ev = Calendar.Events.insert(resource, CONFIG.BOOKING_CALENDAR_ID, { conferenceDataVersion: 1, sendUpdates: 'all' });
    if (!wantsMeet && (ev.hangoutLink || ev.conferenceData)) {
      // Remove an auto-added conference so in-person invites carry no Meet link.
      try { ev = Calendar.Events.patch({ conferenceData: null }, CONFIG.BOOKING_CALENDAR_ID, ev.id, { conferenceDataVersion: 1, sendUpdates: 'all' }); } catch (e) {}
    }
    return ev;
  }

  return getBookingCalendar_().createEvent(title, start, end, {
    description: description,
    location: location || undefined,
    guests: email,
    sendInvites: true
  });
}

function iso_(d) { return Utilities.formatDate(d, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"); }

/**
 * Email the host a summary of a new booking. The guest receives the calendar
 * invite; this is the host's own heads-up (organizers get no invite email for
 * events on their own calendar). Best-effort — callers swallow/log failures.
 */
function notifyHost_(b) {
  var to = (CONFIG.NOTIFY_EMAIL || '').trim();
  if (!to) return;   // no recipient configured -> nothing to send
  var typeLabel = b.type === 'inperson' ? 'In-person' : (b.type === 'online' ? 'Online' : 'Session');
  var when = Utilities.formatDate(b.start, CONFIG.TIMEZONE, "EEE d MMM yyyy, HH:mm") +
    '–' + Utilities.formatDate(b.end, CONFIG.TIMEZONE, "HH:mm") + ' (' + CONFIG.TIMEZONE + ')';
  var subject = 'New booking: ' + b.name + ' — ' + typeLabel + ' ' +
    Utilities.formatDate(b.start, CONFIG.TIMEZONE, "d MMM HH:mm");
  var lines = [
    typeLabel + ' session booked.',
    '',
    'When:  ' + when,
    'Name:  ' + b.name,
    'Email: ' + b.email
  ];
  if (b.notes) lines.push('', 'Notes:', b.notes);
  if (b.links && b.links.length) lines.push('', 'Links:', b.links.map(function (l) { return '- ' + l; }).join('\n'));
  if (b.meetLink) lines.push('', 'Meet: ' + b.meetLink);
  MailApp.sendEmail({ to: to, subject: subject, body: lines.join('\n'), replyTo: b.email || undefined });
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

/** Calendars scanned for conflicts: the configured busy calendars PLUS the
 * booking calendar (so a confirmed booking blocks the time), minus the
 * availability calendar (whose events are offers, not commitments). Deduped and
 * cached per run. */
function getBusyCalendars_() {
  if (_busyCals) return _busyCals;
  var ids = (CONFIG.BUSY_CALENDAR_IDS && CONFIG.BUSY_CALENDAR_IDS.length) ? CONFIG.BUSY_CALENDAR_IDS.slice() : ['primary'];
  if (CONFIG.BOOKING_CALENDAR_ID) ids.push(CONFIG.BOOKING_CALENDAR_ID);
  var availId = getAvailabilityCalendar_().getId();
  _busyCals = [];
  var seen = {};
  for (var i = 0; i < ids.length; i++) {
    var cal = ids[i] === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(ids[i]);
    if (!cal) continue;
    var id = cal.getId();
    if (id === availId || seen[id]) continue;   // skip offers + duplicates
    seen[id] = true;
    _busyCals.push(cal);
  }
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

/** Every availability cache key doGet could have written (one per ?days= value). */
function availCacheKeys_() {
  var keys = [];
  for (var d = 1; d <= CONFIG.LOOKAHEAD_DAYS; d++) keys.push('avail_' + d);
  return keys;
}

// ------------------------- KEEP-WARM (optional) --------------------
// Apps Script web apps go "cold" after a few idle minutes, making the next
// request slow. Run setupKeepWarm() ONCE from the editor (press Run, then
// authorize) to create a trigger that keeps it warm. Run removeKeepWarm() to stop it.

// Recompute availability and write it to the SAME cache the web app reads, so
// the next visitor gets an instant cache hit instead of a slow (cold) recompute.
// Runs in-process — no unreliable self-HTTP call. Reset caches per run so a
// fresh instance recomputes cleanly. Shared by the keep-warm timer AND the
// calendar-edit trigger below, so both "on a schedule" and "the moment you edit
// the calendar" refresh the exact same cache.
function refreshAvailabilityCache_() {
  _availabilityCal = null; _bookingCal = null; _busyCals = null;
  var days = CONFIG.LOOKAHEAD_DAYS;
  // Trusted path: allowDelete=true prunes slots that have crossed their notice window.
  var payload = JSON.stringify({ ok: true, timeZone: CONFIG.TIMEZONE, label: CONFIG.TIMEZONE, slots: computeAvailability_(days, true) });
  CacheService.getScriptCache().put('avail_' + days, payload, CONFIG.CACHE_SECONDS);
}

function keepWarm() {
  try { refreshAvailabilityCache_(); } catch (err) {}
  // Piggyback an hourly cleanup of expired/unbookable slots (no separate trigger).
  try {
    var props = PropertiesService.getScriptProperties();
    if (Date.now() - Number(props.getProperty('lastCleanup') || 0) > 3600000) {
      cleanupExpiredSlots();
      props.setProperty('lastCleanup', String(Date.now()));
    }
  } catch (err) {}
}

// ------------------- LIVE REFRESH ON CALENDAR EDIT ------------------
// Fires whenever an event on the AVAILABILITY calendar is created, edited, or
// deleted (Google's calendar-change triggers usually fire within roughly a
// minute of the edit — not instant, but close). Immediately refreshes the
// cache so your manual calendar changes show up in the widget without waiting
// for the next keep-warm tick. Run setupCalendarChangeTrigger() ONCE from the
// editor to enable; removeCalendarChangeTrigger() to disable.
function onAvailabilityChange() {
  try { refreshAvailabilityCache_(); } catch (err) {}
}

function setupCalendarChangeTrigger() {
  removeCalendarChangeTrigger();
  ScriptApp.newTrigger('onAvailabilityChange')
    .forUserCalendar(CONFIG.AVAILABILITY_CALENDAR_ID)
    .onEventUpdated()
    .create();
}

function removeCalendarChangeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onAvailabilityChange') ScriptApp.deleteTrigger(t);
  });
}

// Delete availability slots that can no longer be booked (past, or now inside the
// MIN_NOTICE window) and were never booked — so old empty slots don't pile up on
// the availability calendar. Booked slots are already removed on booking.
// Runs hourly via keepWarm; can also be Run manually once to clear a backlog.
function cleanupExpiredSlots() {
  var cal = getAvailabilityCalendar_();
  var now = new Date();
  // Fetch out to the widest notice window, then delete each slot against its own
  // type-specific window so a longer online window can't sweep away still-bookable
  // in-person slots (or vice versa).
  var maxNotice = Math.max(CONFIG.MIN_NOTICE_MINUTES,
    CONFIG.MIN_NOTICE_MINUTES_INPERSON != null ? CONFIG.MIN_NOTICE_MINUTES_INPERSON : 0);
  var horizon = new Date(now.getTime() + maxNotice * 60000);
  var from = new Date(now.getTime() - 120 * 86400000);                     // look back 120 days
  var events = cal.getEvents(from, horizon);
  var deleted = 0;
  for (var i = 0; i < events.length && deleted < 200; i++) {               // cap per run
    var ev = events[i];
    if (ev.isAllDayEvent()) continue;                                      // keep all-day notes
    var type = slotType_(ev.getTitle());
    var cutoff = new Date(now.getTime() + noticeMinutesForType_(type) * 60000); // no longer bookable
    if (ev.getStartTime().getTime() < cutoff.getTime()) {
      try { ev.deleteEvent(); deleted++; } catch (_) {}
    }
  }
  return deleted;
}

function setupKeepWarm() {
  removeKeepWarm();
  ScriptApp.newTrigger('keepWarm').timeBased().everyMinutes(1).create();
}

function removeKeepWarm() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'keepWarm') ScriptApp.deleteTrigger(t);
  });
}
