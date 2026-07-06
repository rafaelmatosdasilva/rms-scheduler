/**
 * RMS Scheduler — embeddable booking widget (framework-free).
 *
 * Usage:
 *   <div id="rms-scheduler"></div>
 *   <script src="scheduler.js" data-endpoint="APPS_SCRIPT_EXEC_URL"></script>
 *
 * Optional data-* attributes on the <script> tag:
 *   data-mount="#some-id"    where to render (default "#rms-scheduler")
 *   data-title="Book a call" heading text
 *   data-css="path.css"      override the stylesheet URL (defaults to sibling scheduler.css)
 *   data-timezone="Area/City" force a display timezone (default: visitor's own)
 *
 * Talks to the Apps Script backend using only "simple" requests (GET +
 * text/plain POST) so no CORS preflight is triggered. See Code.gs.
 */
(function () {
  'use strict';

  // Resolve our own <script> even when injected dynamically (document.currentScript
  // is null for appended scripts), so the embed page can build the tag at runtime.
  var script = document.currentScript || (function () {
    var ss = document.querySelectorAll('script[data-endpoint], script[src*="scheduler.js"]');
    return ss[ss.length - 1] || null;
  })();
  var attr = function (n) { return (script && script.getAttribute(n)) || ''; };

  var ENDPOINT = attr('data-endpoint').trim();
  var MOUNT_SEL = attr('data-mount') || '#rms-scheduler';
  var TITLE = attr('data-title') || 'Book a time';
  var VIEW_TZ = attr('data-timezone');
  // Event-info side panel (Calendly-style). All optional.
  var HOST_NAME = attr('data-host-name');
  var HOST_AVATAR = attr('data-host-avatar');
  var LOCATION_TEXT = attr('data-location') || 'Details provided upon confirmation.';

  // width/height on the <svg> so they never render full-size before CSS loads.
  var SV = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">';
  var ICON = {
    clock: SV + '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    video: SV + '<rect x="3" y="6" width="12" height="12" rx="2"/><path d="M15 10l6-3v10l-6-3z"/></svg>',
    cal: SV + '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></svg>',
    globe: SV + '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18"/></svg>',
    pin: SV + '<path d="M12 21s-6-5.4-6-10a6 6 0 1 1 12 0c0 4.6-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/></svg>'
  };

  // Maps a slot's type (from the calendar event title) to a label + icon.
  function slotTypeInfo(type) {
    if (type === 'inperson') return { key: 'inperson', label: 'In person', icon: ICON.pin };
    if (type === 'online') return { key: 'online', label: 'Online', icon: ICON.video };
    return null;
  }
  // Forced palette (independent of the viewer's OS light/dark), settable via
  // data-theme="dark|light". Excludes --rmssch-bg so the card background can be
  // controlled separately (solid or transparent).
  var PALETTES = {
    dark: { '--rmssch-surface': 'rgba(255,255,255,0.08)', '--rmssch-fg': 'rgba(255,255,255,0.95)', '--rmssch-muted': 'rgba(255,255,255,0.5)', '--rmssch-border': 'rgba(255,255,255,0.12)' },
    light: { '--rmssch-surface': 'rgba(0,0,0,0.05)', '--rmssch-fg': 'rgba(0,0,0,0.9)', '--rmssch-muted': 'rgba(0,0,0,0.5)', '--rmssch-border': 'rgba(0,0,0,0.1)' }
  };
  var THEME_NAME = attr('data-theme');

  // Individual theme overrides settable from the embed (data-* attributes).
  var THEME = {
    '--rmssch-accent': attr('data-accent'),
    '--rmssch-accent-contrast': attr('data-accent-contrast'),
    '--rmssch-avail-dot': attr('data-dot'),
    '--rmssch-bg': attr('data-bg'),
    '--rmssch-surface': attr('data-surface'),
    '--rmssch-fg': attr('data-fg'),
    '--rmssch-muted': attr('data-muted'),
    '--rmssch-border': attr('data-border')
  };

  // Kick the availability request off IMMEDIATELY (before DOMContentLoaded), so
  // the network round-trip overlaps with parsing/CSS load. The widget consumes
  // this promise when it mounts.
  function requestAvailability() {
    var url = ENDPOINT + (ENDPOINT.indexOf('?') === -1 ? '?' : '&') + 'action=availability&_=' + Date.now();
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 20000) : null;
    return fetch(url, ctrl ? { method: 'GET', signal: ctrl.signal } : { method: 'GET' })
      .then(function (r) { if (timer) clearTimeout(timer); return r.json(); })
      .catch(function (err) { if (timer) clearTimeout(timer); throw err; });
  }
  var PREFETCH = ENDPOINT ? requestAvailability() : null;

  // Load the Manrope webfont used by the widget.
  (function loadFont() {
    if (document.querySelector('link[data-rmssch-font]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap';
    l.setAttribute('data-rmssch-font', '1');
    document.head.appendChild(l);
  })();

  (function loadCss() {
    var href = script && script.getAttribute('data-css');
    if (!href && script && script.src) href = script.src.replace(/scheduler\.js(\?.*)?$/, 'scheduler.css');
    if (!href) return;
    // Cache-bust so style updates always take effect (GitHub Pages caches ~10min).
    href += (href.indexOf('?') === -1 ? '?' : '&') + 'v=' + Date.now();
    if (document.querySelector('link[data-rmssch]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-rmssch', '1');
    document.head.appendChild(link);
  })();

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    var root = document.querySelector(MOUNT_SEL);
    if (!root) return;
    root.id = root.id || 'rms-scheduler';
    // Apply forced palette first, then individual overrides (persist on the
    // container across re-renders).
    var pal = PALETTES[THEME_NAME];
    if (pal) for (var p in pal) root.style.setProperty(p, pal[p]);
    var color = function (v) { return /^[0-9a-fA-F]{3,8}$/.test(v) ? '#' + v : v; };
    for (var k in THEME) { if (THEME[k]) root.style.setProperty(k, color(THEME[k])); }
    if (!ENDPOINT) {
      root.innerHTML = '<p class="rmssch-msg rmssch-error">Scheduler not configured: missing data-endpoint.</p>';
      return;
    }
    new Widget(root).start();
  });

  var DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // ------------------------------------------------------------------

  function Widget(root) {
    this.root = root;
    this.tz = null;
    this.viewTz = VIEW_TZ || (Intl.DateTimeFormat().resolvedOptions().timeZone) || undefined;
    this.byDay = {};        // 'YYYY-MM-DD' -> [{start,end}...]
    this.slotByStart = {};  // start ISO -> {start,end}
    this.dayKeys = [];      // sorted available day keys
    this.selectedDay = null;
    this.selectedSlot = null;
    this.hour12 = detectHour12();  // default from the visitor's locale
    this.viewY = null;      // calendar month currently displayed
    this.viewM = null;
  }

  Widget.prototype.start = function () { this.renderSkeleton(); this.fetchSlots(); };

  Widget.prototype.fetchSlots = function () {
    var self = this;
    var p = PREFETCH || requestAvailability();
    PREFETCH = null; // consume once
    p.then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || 'Bad response');
        self.tz = data.timeZone || undefined;
        self.groupByDay(data.slots || []);
        self.renderPicker();
      })
      .catch(function (err) {
        try { console.error('[rms-scheduler] availability request failed:', err); } catch (_) {}
        var aborted = err && err.name === 'AbortError';
        var detail = err ? ((err.name || 'Error') + ': ' + (err.message || String(err))) : '';
        self.renderError(aborted ? 'Timed out loading times (20s). Tap retry.' : 'Could not load available times.', detail);
      });
  };

  // A calendar-shaped placeholder shown instantly while slots load.
  Widget.prototype.renderSkeleton = function () {
    this.root.classList.remove('rmssch-centered');
    var now = new Date();
    var monthName = new Intl.DateTimeFormat(undefined, { month: 'long' }).format(now);
    var dows = DOW.map(function (n) { return '<span>' + n.toUpperCase() + '</span>'; }).join('');
    var cells = ''; for (var i = 0; i < 42; i++) cells += '<span class="rmssch-cell rmssch-skel"></span>';
    var pills = ''; for (var j = 0; j < 6; j++) pills += '<div class="rmssch-slot rmssch-skel"></div>';
    var strip = ''; for (var k = 0; k < 8; k++) strip += '<span class="rmssch-daypill rmssch-skel" style="height:52px"></span>';
    // Mirror the loaded picker structure exactly (same header/nav/day-head) so
    // nothing shifts when real data replaces the skeleton.
    this.shell('<div class="rmssch-picker">' +
      '<div class="rmssch-cal">' +
        '<div class="rmssch-cal-head">' +
          '<div class="rmssch-cal-title"><strong>' + esc(monthName) + '</strong> ' + now.getFullYear() + '</div>' +
          '<div class="rmssch-cal-nav"><button type="button" disabled>‹</button><button type="button" disabled>›</button></div>' +
        '</div>' +
        '<div class="rmssch-cal-dows">' + dows + '</div>' +
        '<div class="rmssch-cal-grid">' + cells + '</div>' +
      '</div>' +
      '<div class="rmssch-day">' +
        '<div class="rmssch-daystrip">' + strip + '</div>' +
        '<div class="rmssch-day-head">' +
          '<div class="rmssch-day-title rmssch-skel" style="width:72px;height:22px"></div>' +
        '</div>' +
        '<div class="rmssch-slots">' + pills + '</div>' +
      '</div>' +
    '</div>');
  };

  Widget.prototype.groupByDay = function (slots) {
    this.byDay = {}; this.slotByStart = {}; this.dayKeys = [];
    for (var i = 0; i < slots.length; i++) {
      var slot = typeof slots[i] === 'string' ? { start: slots[i] } : slots[i];
      var key = this.dayKeyFromIso(slot.start);
      if (!this.byDay[key]) { this.byDay[key] = []; this.dayKeys.push(key); }
      this.byDay[key].push(slot);
      this.slotByStart[slot.start] = slot;
    }
    this.selectedDay = this.dayKeys[0] || null;
    if (this.selectedDay) {
      var p = this.selectedDay.split('-');
      this.viewY = +p[0]; this.viewM = +p[1] - 1;
    }
  };

  // ---- formatting (in the display timezone) ----------------------

  Widget.prototype.fmt = function (iso, opts) {
    return new Intl.DateTimeFormat(opts.locale || undefined,
      Object.assign({ timeZone: this.viewTz }, opts.o)).format(new Date(iso));
  };
  Widget.prototype.dayKeyFromIso = function (iso) {
    var p = new Intl.DateTimeFormat('en-CA', { timeZone: this.viewTz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(iso));
    return p; // en-CA yields YYYY-MM-DD
  };
  Widget.prototype.timeLabel = function (iso) {
    var d = new Date(iso);
    if (this.hour12) {
      return new Intl.DateTimeFormat('en-US', { timeZone: this.viewTz, hour: 'numeric', minute: '2-digit', hour12: true })
        .format(d).replace(' AM', 'am').replace(' PM', 'pm');
    }
    return new Intl.DateTimeFormat('en-GB', { timeZone: this.viewTz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  };
  Widget.prototype.fullLabel = function (iso) {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: this.viewTz, weekday: 'long', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: this.hour12
    }).format(new Date(iso));
  };
  Widget.prototype.durationLabel = function (slot) {
    if (!slot.end) return '';
    var mins = Math.round((new Date(slot.end) - new Date(slot.start)) / 60000);
    if (!mins || mins < 0) return '';
    if (mins < 60) return mins + ' min';
    var h = Math.floor(mins / 60), m = mins % 60;
    return m ? h + 'h ' + m + 'm' : h + ' hr' + (h > 1 ? 's' : '');
  };
  Widget.prototype.slotLabel = function (slot) {
    var d = this.durationLabel(slot);
    return this.fullLabel(slot.start) + (d ? ' · ' + d : '');
  };
  // "10:00am – 10:20am, Tuesday, July 7, 2026"
  Widget.prototype.slotRangeLabel = function (slot) {
    var day = new Intl.DateTimeFormat(undefined, {
      timeZone: this.viewTz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    }).format(new Date(slot.start));
    return this.timeLabel(slot.start) + (slot.end ? ' – ' + this.timeLabel(slot.end) : '') + ', ' + day;
  };

  // ---- shells ----------------------------------------------------

  Widget.prototype.frame = function (html) { this.root.innerHTML = html; };

  // Left event-info panel. Reflects the current selection.
  Widget.prototype.infoHtml = function () {
    var slot = this.selectedSlot;
    function row(icon, text, muted) {
      return '<div class="rmssch-info-row' + (muted ? ' is-muted' : '') + '"><span class="rmssch-ic">' + icon + '</span><span>' + esc(text) + '</span></div>';
    }
    var host = (HOST_AVATAR || HOST_NAME) ? '<div class="rmssch-host">' +
      (HOST_AVATAR ? '<img class="rmssch-host-av" width="56" height="56" src="' + esc(HOST_AVATAR) + '" alt="" onerror="this.style.display=\'none\'">' : '') +
      (HOST_NAME ? '<div class="rmssch-host-name">' + esc(HOST_NAME) + '</div>' : '') + '</div>' : '';
    var dur = slot ? this.durationLabel(slot) : '';
    var ti = slot ? slotTypeInfo(slot.type) : null;
    // In-person slots show a pin + "In person"; everything else keeps the default (Meet) line.
    var locRow = (ti && ti.key === 'inperson') ? row(ti.icon, ti.label) : row(ICON.video, LOCATION_TEXT);
    return '<div class="rmssch-info">' +
      '<div class="rmssch-info-head">' + host + '<div class="rmssch-info-title">' + esc(TITLE) + '</div></div>' +
      '<div class="rmssch-info-meta">' +
        locRow +
        row(ICON.cal, slot ? this.slotRangeLabel(slot) : 'Select a date & time', !slot) +
        (dur ? row(ICON.clock, dur) : '') +   // duration below the date/time
        (this.viewTz ? row(ICON.globe, this.viewTz.replace(/_/g, ' ')) : '') +
      '</div>' +
    '</div>';
  };

  // Wrap the current step's main content with the persistent info panel.
  Widget.prototype.shell = function (mainHtml) {
    this.root.classList.remove('rmssch-centered');
    this.frame('<div class="rmssch-shell">' + this.infoHtml() + '<div class="rmssch-main">' + mainHtml + '</div></div>');
  };

  Widget.prototype.card = function (inner) {
    // Simple centered states (loading / error / form / confirmation).
    this.root.classList.add('rmssch-centered');
    this.frame(
      '<div class="rmssch-title">' + esc(TITLE) + '</div>' +
      '<div class="rmssch-sub">' + (this.viewTz ? 'Times shown in your timezone · ' + esc(this.viewTz.replace(/_/g, ' ')) : '&nbsp;') + '</div>' +
      '<div class="rmssch-narrow">' + inner + '</div>');
  };

  Widget.prototype.renderLoading = function () {
    this.card('<div class="rmssch-msg"><span class="rmssch-spinner"></span> Loading available times…</div>');
  };

  Widget.prototype.renderError = function (msg, detail) {
    var self = this;
    this.card('<div class="rmssch-msg rmssch-error">' + esc(msg) + '</div>' +
      (detail ? '<div class="rmssch-msg" style="font-size:0.72rem;opacity:0.7">' + esc(detail) + '</div>' : '') +
      '<div class="rmssch-actions"><button class="rmssch-btn" type="button">Retry</button></div>');
    this.root.querySelector('button').onclick = function () { self.start(); };
  };

  // ---- picker: month calendar + time panel -----------------------

  Widget.prototype.pickerHtml = function () {
    return '<div class="rmssch-picker">' + this.calendarHtml() + this.dayPanelHtml() + '</div>';
  };

  Widget.prototype.renderPicker = function () {
    if (!this.dayKeys.length) {
      this.card('<div class="rmssch-msg">No open times right now. Please check back later.</div>');
      return;
    }
    this.shell(this.pickerHtml());   // full render, incl. the info panel
    this.bindPicker();
  };

  // Re-render ONLY the picker (calendar + day panel), leaving the info panel —
  // and its <img> avatar — untouched, so day/month/format changes don't flicker.
  Widget.prototype.updatePicker = function () {
    var main = this.root.querySelector('.rmssch-main');
    if (!main) { this.renderPicker(); return; }
    main.innerHTML = this.pickerHtml();
    this.bindPicker();
  };

  Widget.prototype.bindPicker = function () {
    var self = this;
    this.root.querySelectorAll('[data-day]').forEach(function (b) {
      b.onclick = function () { self.selectedDay = b.getAttribute('data-day'); self.updatePicker(); };
    });
    this.root.querySelectorAll('[data-mon]').forEach(function (b) {
      b.onclick = function () {
        if (b.disabled) return;
        var idx = self.viewY * 12 + self.viewM + (b.getAttribute('data-mon') === 'next' ? 1 : -1);
        self.viewY = Math.floor(idx / 12); self.viewM = idx % 12; self.updatePicker();
      };
    });
    this.root.querySelectorAll('[data-fmt]').forEach(function (b) {
      b.onclick = function () { self.hour12 = b.getAttribute('data-fmt') === '12'; self.updatePicker(); };
    });
    this.root.querySelectorAll('.rmssch-slot').forEach(function (b) {
      b.onclick = function () { self.selectedSlot = self.slotByStart[b.getAttribute('data-slot')]; self.renderForm(); };
    });
  };

  Widget.prototype.calendarHtml = function () {
    var y = this.viewY, m = this.viewM;
    var monthName = new Intl.DateTimeFormat(undefined, { month: 'long' }).format(new Date(y, m, 1));
    var offset = (new Date(y, m, 1).getDay() + 6) % 7;      // Monday-first
    var dim = new Date(y, m + 1, 0).getDate();
    var todayKey = this.dayKeyFromIso(new Date().toISOString());
    var monthIdx = y * 12 + m;
    var firstIdx = monthIndex_(this.dayKeys[0]);
    var lastIdx = monthIndex_(this.dayKeys[this.dayKeys.length - 1]);

    var cells = '';
    for (var b = 0; b < offset; b++) cells += '<span class="rmssch-cell rmssch-cell--empty"></span>';
    for (var d = 1; d <= dim; d++) {
      var key = y + '-' + pad(m + 1) + '-' + pad(d);
      var dot = key === todayKey ? '<span class="rmssch-cell-dot"></span>' : '';
      if (this.byDay[key]) {
        var sel = key === this.selectedDay ? ' is-sel' : '';
        cells += '<button type="button" class="rmssch-cell is-avail' + sel + '" data-day="' + key + '">' + d + dot + '</button>';
      } else {
        cells += '<span class="rmssch-cell is-off">' + d + dot + '</span>';
      }
    }
    // Pad to a constant 6 rows (42 cells) so the grid height never changes
    // between months (5- vs 6-week months).
    for (var t = offset + dim; t < 42; t++) cells += '<span class="rmssch-cell rmssch-cell--empty"></span>';

    var dows = DOW.map(function (n) { return '<span>' + n.toUpperCase() + '</span>'; }).join('');
    return '<div class="rmssch-cal">' +
      '<div class="rmssch-cal-head">' +
        '<div class="rmssch-cal-title"><strong>' + esc(monthName) + '</strong> ' + y + '</div>' +
        '<div class="rmssch-cal-nav">' +
          '<button type="button" data-mon="prev" aria-label="Previous month"' + (monthIdx <= firstIdx ? ' disabled' : '') + '>‹</button>' +
          '<button type="button" data-mon="next" aria-label="Next month"' + (monthIdx >= lastIdx ? ' disabled' : '') + '>›</button>' +
        '</div>' +
      '</div>' +
      '<div class="rmssch-cal-dows">' + dows + '</div>' +
      '<div class="rmssch-cal-grid">' + cells + '</div>' +
    '</div>';
  };

  Widget.prototype.dayPanelHtml = function () {
    var self = this;
    var iso = this.byDay[this.selectedDay][0].start;
    var wd = new Intl.DateTimeFormat('en-US', { timeZone: this.viewTz, weekday: 'short' }).format(new Date(iso));
    var dd = new Intl.DateTimeFormat('en-US', { timeZone: this.viewTz, day: '2-digit' }).format(new Date(iso));

    var slots = this.byDay[this.selectedDay].map(function (slot) {
      var ti = slotTypeInfo(slot.type);
      var sub = [self.durationLabel(slot), ti ? ti.label : ''].filter(Boolean).join(' · ');
      return '<button type="button" class="rmssch-slot" data-slot="' + esc(slot.start) + '">' +
        '<span class="rmssch-slot-dot"></span>' +
        '<span class="rmssch-slot-time">' + esc(self.timeLabel(slot.start)) + '</span>' +
        (sub ? '<span class="rmssch-slot-dur">' + esc(sub) + '</span>' : '') +
      '</button>';
    }).join('');

    // Horizontal day strip (shown instead of the month grid on small screens).
    var strip = this.dayKeys.map(function (key) {
      var i = self.byDay[key][0].start;
      var sel = key === self.selectedDay ? ' is-sel' : '';
      return '<button type="button" class="rmssch-daypill' + sel + '" data-day="' + key + '">' +
        '<span class="rmssch-daypill-dow">' + esc(new Intl.DateTimeFormat('en-US', { timeZone: self.viewTz, weekday: 'short' }).format(new Date(i))) + '</span>' +
        '<span class="rmssch-daypill-num">' + esc(new Intl.DateTimeFormat('en-US', { timeZone: self.viewTz, day: 'numeric' }).format(new Date(i))) + '</span>' +
      '</button>';
    }).join('');

    return '<div class="rmssch-day">' +
      '<div class="rmssch-daystrip">' + strip + '</div>' +
      '<div class="rmssch-day-head">' +
        '<div class="rmssch-day-title"><strong>' + esc(wd) + '</strong> ' + esc(dd) + '</div>' +
      '</div>' +
      '<div class="rmssch-slots">' + slots + '</div>' +
    '</div>';
  };

  // ---- form / submit / confirm -----------------------------------

  Widget.prototype.renderForm = function () {
    var self = this;
    this.shell(
      '<div class="rmssch-form-head">Enter your details</div>' +
      '<form class="rmssch-form" novalidate>' +
        '<div class="rmssch-field"><label><span class="rmssch-lbl">Name <span class="rmssch-req">*</span></span><input name="name" type="text" required autocomplete="name"></label></div>' +
        '<div class="rmssch-field"><label><span class="rmssch-lbl">Email <span class="rmssch-req">*</span></span><input name="email" type="email" required autocomplete="email"></label></div>' +
        '<div class="rmssch-field"><label><span class="rmssch-lbl">Notes (optional)</span><textarea name="notes" rows="2"></textarea></label></div>' +
        '<div class="rmssch-hp" aria-hidden="true"><label>Leave this field empty<input name="hp_check" tabindex="-1" autocomplete="off"></label></div>' +
        '<div class="rmssch-msg rmssch-error" data-err hidden></div>' +
        '<div class="rmssch-actions">' +
          '<button class="rmssch-back" type="button" data-back>Back</button>' +
          '<button class="rmssch-btn" type="submit">Confirm booking</button>' +
        '</div>' +
      '</form>');
    this.root.querySelector('[data-back]').onclick = function () { self.selectedSlot = null; self.renderPicker(); };
    this.root.querySelector('.rmssch-form').onsubmit = function (e) { e.preventDefault(); self.submit(this); };
  };

  Widget.prototype.submit = function (form) {
    var self = this;
    var errEl = form.querySelector('[data-err]');
    var name = form.name.value.trim();
    var email = form.email.value.trim();
    if (!name) return showErr(errEl, 'Please enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showErr(errEl, 'Please enter a valid email.');
    errEl.hidden = true;

    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.innerHTML = '<span class="rmssch-spinner"></span> Booking…';

    var payload = { start: this.selectedSlot.start, name: name, email: email, notes: form.notes.value.trim(), hp: form.hp_check.value };
    fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok) return self.renderConfirm(name, email);
        if (data && data.reason === 'taken') { self.selectedSlot = null; self.start(); return; }
        btn.disabled = false; btn.textContent = 'Confirm booking';
        showErr(errEl, (data && data.message) || 'Something went wrong. Please try again.');
      })
      .catch(function () {
        btn.disabled = false; btn.textContent = 'Confirm booking';
        showErr(errEl, 'Network error. Please try again.');
      });
  };

  Widget.prototype.renderConfirm = function (name, email) {
    // The details live in the info panel; the main area shows the confirmation.
    this.shell(
      '<div class="rmssch-confirm">' +
        '<div class="rmssch-confirm-check">✓</div>' +
        '<div class="rmssch-title">You’re booked!</div>' +
        '<p class="rmssch-msg">A calendar invite is on its way to ' + esc(email) + '.</p>' +
      '</div>');
  };

  // ---- utils -----------------------------------------------------

  // Does the visitor's locale use a 12-hour clock?
  function detectHour12() {
    try {
      var r = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions();
      if (typeof r.hour12 === 'boolean') return r.hour12;
      return !(r.hourCycle === 'h23' || r.hourCycle === 'h24');
    } catch (_) { return true; }
  }

  function monthIndex_(key) { var p = key.split('-'); return (+p[0]) * 12 + (+p[1] - 1); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function showErr(el, msg) { el.textContent = msg; el.hidden = false; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
