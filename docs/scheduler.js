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
  // Theme overrides settable from the embed (data-* attributes).
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

  (function loadCss() {
    var href = script && script.getAttribute('data-css');
    if (!href && script && script.src) href = script.src.replace(/scheduler\.js(\?.*)?$/, 'scheduler.css');
    if (!href) return;
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
    // Apply embed theme overrides (persist on the container across re-renders).
    for (var k in THEME) { if (THEME[k]) root.style.setProperty(k, THEME[k]); }
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
    this.hour12 = true;
    this.viewY = null;      // calendar month currently displayed
    this.viewM = null;
  }

  Widget.prototype.start = function () { this.renderLoading(); this.fetchSlots(); };

  Widget.prototype.fetchSlots = function () {
    var self = this;
    var url = ENDPOINT + (ENDPOINT.indexOf('?') === -1 ? '?' : '&') + 'action=availability&_=' + Date.now();
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 20000) : null;
    fetch(url, ctrl ? { method: 'GET', signal: ctrl.signal } : { method: 'GET' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (timer) clearTimeout(timer);
        if (!data || !data.ok) throw new Error((data && data.error) || 'Bad response');
        self.tz = data.timeZone || undefined;
        self.groupByDay(data.slots || []);
        self.renderPicker();
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        try { console.error('[rms-scheduler] availability request failed:', err); } catch (_) {}
        var aborted = err && err.name === 'AbortError';
        var detail = err ? ((err.name || 'Error') + ': ' + (err.message || String(err))) : '';
        self.renderError(aborted ? 'Timed out loading times (20s). Tap retry.' : 'Could not load available times.', detail);
      });
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

  // ---- shells ----------------------------------------------------

  Widget.prototype.frame = function (html) { this.root.innerHTML = html; };

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

  Widget.prototype.renderPicker = function () {
    var self = this;
    if (!this.dayKeys.length) {
      this.card('<div class="rmssch-msg">No open times right now. Please check back later.</div>');
      return;
    }
    this.root.classList.remove('rmssch-centered');
    this.frame(
      '<div class="rmssch-picker">' +
        this.calendarHtml() +
        this.dayPanelHtml() +
      '</div>');

    // Day selection
    this.root.querySelectorAll('.rmssch-cell.is-avail').forEach(function (b) {
      b.onclick = function () { self.selectedDay = b.getAttribute('data-day'); self.renderPicker(); };
    });
    // Month nav
    this.root.querySelectorAll('[data-mon]').forEach(function (b) {
      b.onclick = function () {
        if (b.disabled) return;
        var idx = self.viewY * 12 + self.viewM + (b.getAttribute('data-mon') === 'next' ? 1 : -1);
        self.viewY = Math.floor(idx / 12); self.viewM = idx % 12; self.renderPicker();
      };
    });
    // 12h / 24h
    this.root.querySelectorAll('[data-fmt]').forEach(function (b) {
      b.onclick = function () { self.hour12 = b.getAttribute('data-fmt') === '12'; self.renderPicker(); };
    });
    // Time selection
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
      var dur = self.durationLabel(slot);
      return '<button type="button" class="rmssch-slot" data-slot="' + esc(slot.start) + '">' +
        '<span class="rmssch-slot-dot"></span>' +
        '<span class="rmssch-slot-time">' + esc(self.timeLabel(slot.start)) + '</span>' +
        (dur ? '<span class="rmssch-slot-dur">' + esc(dur) + '</span>' : '') +
      '</button>';
    }).join('');

    return '<div class="rmssch-day">' +
      '<div class="rmssch-day-head">' +
        '<div class="rmssch-day-title"><strong>' + esc(wd) + '</strong> ' + esc(dd) + '</div>' +
        '<div class="rmssch-seg">' +
          '<button type="button" data-fmt="12" class="' + (this.hour12 ? 'is-on' : '') + '">12h</button>' +
          '<button type="button" data-fmt="24" class="' + (!this.hour12 ? 'is-on' : '') + '">24h</button>' +
        '</div>' +
      '</div>' +
      '<div class="rmssch-slots">' + slots + '</div>' +
      '<div class="rmssch-tz">' + (this.viewTz ? esc(this.viewTz.replace(/_/g, ' ')) : '') + '</div>' +
    '</div>';
  };

  // ---- form / submit / confirm -----------------------------------

  Widget.prototype.renderForm = function () {
    var self = this;
    this.card(
      '<div class="rmssch-selected">' + esc(this.slotLabel(this.selectedSlot)) + '</div>' +
      '<form class="rmssch-form" novalidate>' +
        '<div class="rmssch-field"><label>Name<input name="name" type="text" required autocomplete="name"></label></div>' +
        '<div class="rmssch-field"><label>Email<input name="email" type="email" required autocomplete="email"></label></div>' +
        '<div class="rmssch-field"><label>Notes (optional)<textarea name="notes" rows="2"></textarea></label></div>' +
        '<div class="rmssch-hp" aria-hidden="true"><label>Company<input name="company" tabindex="-1" autocomplete="off"></label></div>' +
        '<div class="rmssch-msg rmssch-error" data-err hidden></div>' +
        '<div class="rmssch-actions">' +
          '<button class="rmssch-btn rmssch-btn--ghost" type="button" data-back>Back</button>' +
          '<button class="rmssch-btn" type="submit">Confirm booking</button>' +
        '</div>' +
      '</form>');
    this.root.querySelector('[data-back]').onclick = function () { self.renderPicker(); };
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

    var payload = { start: this.selectedSlot.start, name: name, email: email, notes: form.notes.value.trim(), company: form.company.value };
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
    this.card(
      '<div class="rmssch-confirm">' +
        '<div class="rmssch-confirm-check">✓</div>' +
        '<div class="rmssch-title">You’re booked!</div>' +
        '<p class="rmssch-sub">' + esc(this.slotLabel(this.selectedSlot)) + '</p>' +
        '<p class="rmssch-msg">A calendar invite is on its way to ' + esc(email) + '.</p>' +
      '</div>');
  };

  // ---- utils -----------------------------------------------------

  function monthIndex_(key) { var p = key.split('-'); return (+p[0]) * 12 + (+p[1] - 1); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function showErr(el, msg) { el.textContent = msg; el.hidden = false; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
