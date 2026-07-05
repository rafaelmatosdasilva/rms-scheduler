/**
 * RMS Scheduler — embeddable booking widget (framework-free).
 *
 * Usage:
 *   <div id="rms-scheduler"></div>
 *   <script src="scheduler.js" data-endpoint="APPS_SCRIPT_EXEC_URL"></script>
 *
 * Optional data-* attributes on the <script> tag:
 *   data-mount="#some-id"   where to render (default "#rms-scheduler")
 *   data-title="Book a call" heading text
 *   data-css="path.css"     override the stylesheet URL (defaults to sibling scheduler.css)
 *
 * Talks to the Apps Script backend using only "simple" requests (GET +
 * text/plain POST) so no CORS preflight is triggered. See Code.gs.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var ENDPOINT = (script && script.getAttribute('data-endpoint') || '').trim();
  var MOUNT_SEL = (script && script.getAttribute('data-mount')) || '#rms-scheduler';
  var TITLE = (script && script.getAttribute('data-title')) || 'Book a time';

  // Load the stylesheet (sibling of this script unless overridden).
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
    if (!ENDPOINT) {
      root.innerHTML = '<p class="rmssch-msg rmssch-error">Scheduler not configured: missing data-endpoint.</p>';
      return;
    }
    new Widget(root).start();
  });

  // ------------------------------------------------------------------

  function Widget(root) {
    this.root = root;
    this.tz = null;
    this.slotMinutes = 30;
    this.byDay = {};      // 'YYYY-MM-DD' (owner tz) -> [ISO strings]
    this.dayKeys = [];
    this.selectedDay = null;
    this.selectedSlot = null;
  }

  Widget.prototype.start = function () {
    this.renderLoading();
    this.fetchSlots();
  };

  Widget.prototype.fetchSlots = function () {
    var self = this;
    var url = ENDPOINT + (ENDPOINT.indexOf('?') === -1 ? '?' : '&') + 'action=availability&_=' + Date.now();
    fetch(url, { method: 'GET' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || 'Bad response');
        self.tz = data.timeZone || undefined;
        self.slotMinutes = data.slotMinutes || 30;
        self.groupByDay(data.slots || []);
        self.renderPicker();
      })
      .catch(function () {
        self.renderError('Could not load available times. Please try again shortly.');
      });
  };

  Widget.prototype.groupByDay = function (slots) {
    this.byDay = {};
    this.dayKeys = [];
    for (var i = 0; i < slots.length; i++) {
      var key = this.dayKey(slots[i]);
      if (!this.byDay[key]) { this.byDay[key] = []; this.dayKeys.push(key); }
      this.byDay[key].push(slots[i]);
    }
    this.selectedDay = this.dayKeys[0] || null;
  };

  // ---- date formatting in the OWNER's timezone -------------------

  Widget.prototype.parts = function (iso, opts) {
    var o = Object.assign({ timeZone: this.tz }, opts);
    return new Intl.DateTimeFormat(undefined, o).formatToParts(new Date(iso))
      .reduce(function (acc, p) { acc[p.type] = p.value; return acc; }, {});
  };

  Widget.prototype.dayKey = function (iso) {
    var p = this.parts(iso, { year: 'numeric', month: '2-digit', day: '2-digit' });
    return p.year + '-' + p.month + '-' + p.day;
  };
  Widget.prototype.dow = function (iso) {
    return this.parts(iso, { weekday: 'short' }).weekday;
  };
  Widget.prototype.dayNum = function (iso) {
    return this.parts(iso, { day: 'numeric' }).day;
  };
  Widget.prototype.timeLabel = function (iso) {
    var p = this.parts(iso, { hour: '2-digit', minute: '2-digit' });
    return p.hour + ':' + p.minute;
  };
  Widget.prototype.fullLabel = function (iso) {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: this.tz, weekday: 'long', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    }).format(new Date(iso));
  };

  // ---- rendering -------------------------------------------------

  Widget.prototype.el = function (html) {
    this.root.innerHTML =
      '<div class="rmssch-title">' + esc(TITLE) + '</div>' +
      '<div class="rmssch-sub">' + (this.tz ? 'All times ' + esc(this.tz) : '&nbsp;') + '</div>' +
      html;
  };

  Widget.prototype.renderLoading = function () {
    this.el('<div class="rmssch-msg"><span class="rmssch-spinner"></span> Loading available times…</div>');
  };

  Widget.prototype.renderError = function (msg) {
    var self = this;
    this.el('<div class="rmssch-msg rmssch-error">' + esc(msg) + '</div>' +
      '<div class="rmssch-actions"><button class="rmssch-btn" type="button">Retry</button></div>');
    this.root.querySelector('button').onclick = function () { self.start(); };
  };

  Widget.prototype.renderPicker = function () {
    var self = this;
    if (!this.dayKeys.length) {
      this.el('<div class="rmssch-msg">No open times in the coming days. Please check back later.</div>');
      return;
    }
    var days = this.dayKeys.map(function (key) {
      var iso = self.byDay[key][0];
      var sel = key === self.selectedDay ? 'true' : 'false';
      return '<button class="rmssch-day" type="button" role="tab" aria-selected="' + sel + '" data-day="' + key + '">' +
        '<span class="rmssch-day-dow">' + esc(self.dow(iso)) + '</span>' +
        '<span class="rmssch-day-num">' + esc(self.dayNum(iso)) + '</span>' +
        '</button>';
    }).join('');

    var times = (this.byDay[this.selectedDay] || []).map(function (iso) {
      return '<button class="rmssch-time" type="button" data-slot="' + esc(iso) + '">' +
        esc(self.timeLabel(iso)) + '</button>';
    }).join('');

    this.el('<div class="rmssch-days" role="tablist">' + days + '</div>' +
      '<div class="rmssch-times">' + times + '</div>');

    this.root.querySelectorAll('.rmssch-day').forEach(function (btn) {
      btn.onclick = function () { self.selectedDay = btn.getAttribute('data-day'); self.renderPicker(); };
    });
    this.root.querySelectorAll('.rmssch-time').forEach(function (btn) {
      btn.onclick = function () { self.selectedSlot = btn.getAttribute('data-slot'); self.renderForm(); };
    });
  };

  Widget.prototype.renderForm = function () {
    var self = this;
    this.el(
      '<div class="rmssch-selected">' + esc(this.fullLabel(this.selectedSlot)) + '</div>' +
      '<form class="rmssch-form" novalidate>' +
        '<div class="rmssch-field"><label>Name<input name="name" type="text" required autocomplete="name"></label></div>' +
        '<div class="rmssch-field"><label>Email<input name="email" type="email" required autocomplete="email"></label></div>' +
        '<div class="rmssch-field"><label>Notes (optional)<textarea name="notes" rows="2"></textarea></label></div>' +
        '<div class="rmssch-hp" aria-hidden="true"><label>Company<input name="company" tabindex="-1" autocomplete="off"></label></div>' +
        '<div class="rmssch-msg rmssch-error" data-err hidden></div>' +
        '<div class="rmssch-actions">' +
          '<button class="rmssch-btn" type="submit">Confirm booking</button>' +
          '<button class="rmssch-btn rmssch-btn--ghost" type="button" data-back>Back</button>' +
        '</div>' +
      '</form>');

    this.root.querySelector('[data-back]').onclick = function () { self.renderPicker(); };
    this.root.querySelector('.rmssch-form').onsubmit = function (e) {
      e.preventDefault();
      self.submit(this);
    };
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

    var payload = {
      start: this.selectedSlot,
      name: name,
      email: email,
      notes: form.notes.value.trim(),
      company: form.company.value // honeypot
    };

    // text/plain avoids a CORS preflight against the Apps Script endpoint.
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok) return self.renderConfirm(name, email);
        if (data && data.reason === 'taken') {
          self.selectedSlot = null;
          self.renderError('Sorry, that slot was just booked. Let’s pick another.');
          return;
        }
        btn.disabled = false;
        btn.textContent = 'Confirm booking';
        showErr(errEl, (data && data.message) || 'Something went wrong. Please try again.');
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = 'Confirm booking';
        showErr(errEl, 'Network error. Please try again.');
      });
  };

  Widget.prototype.renderConfirm = function (name, email) {
    this.el(
      '<div class="rmssch-confirm">' +
        '<div class="rmssch-confirm-check">✓</div>' +
        '<div class="rmssch-title">You’re booked!</div>' +
        '<p class="rmssch-sub">' + esc(this.fullLabel(this.selectedSlot)) + '</p>' +
        '<p class="rmssch-msg">A calendar invite is on its way to ' + esc(email) + '.</p>' +
      '</div>');
  };

  // ---- utils -----------------------------------------------------

  function showErr(el, msg) { el.textContent = msg; el.hidden = false; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
