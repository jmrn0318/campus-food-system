/* Shared helpers for the student app and the staff board */
(function () {
  'use strict';

  /** Escape text before putting it into innerHTML (prevents XSS from names/notes). */
  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function peso(amount) {
    return '\u20B1' + Number(amount).toLocaleString('en-PH');
  }

  function timeOf(iso) {
    return new Date(iso).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
  }

  function dateTimeOf(iso) {
    return new Date(iso).toLocaleString('en-PH', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  /** Helper to return the correct food image path or default photo */
  function getFoodImage(imageUrl) {
    if (imageUrl && imageUrl.trim() !== '') {
      return imageUrl;
    }
    return '/images/default-food.jpg';
  }

  /** fetch() wrapper that returns JSON and throws an Error with a readable message. */
  async function api(path, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});

    try {
      var token = JSON.parse(localStorage.getItem('cfs_token') || 'null');
      if (token && !headers.Authorization) headers.Authorization = 'Bearer ' + token;
    } catch (e) {
      /* ignore storage restrictions */
    }
    
    // Automatically set JSON Content-Type unless sending FormData (for image uploads)
    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    var res;
    try {
      res = await fetch(path, Object.assign({}, options, { headers: headers }));
    } catch (e) {
      var offline = new Error('Cannot reach the server. Check your connection and try again.');
      offline.status = 0;
      throw offline;
    }
    var data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* ignore empty / non-JSON bodies */
    }
    if (!res.ok) {
      var err = new Error((data && data.error) || 'Something went wrong. Please try again.');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /**
   * Same formula as the server (server.js -> estimateMinutes):
   * longest prep time + 1 min per 2 extra pieces + queue delay.
   * lines = [{ prepMinutes, qty }]
   */
  function estimateMinutes(lines, queueDelayMinutes) {
    var longest = Math.max.apply(
      null,
      lines.map(function (l) {
        return l.prepMinutes;
      })
    );
    var totalQty = lines.reduce(function (sum, l) {
      return sum + l.qty;
    }, 0);
    return longest + Math.ceil((totalQty - 1) / 2) + (queueDelayMinutes || 0);
  }

  /** Two short beeps. Browsers may block audio until the person has tapped something. */
  function beep() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = new AC();
      [0, 0.24].forEach(function (delay, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        var start = ctx.currentTime + delay;
        osc.type = 'sine';
        osc.frequency.value = i ? 1046 : 784;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.22);
      });
    } catch (e) {
      /* audio is optional */
    }
  }

  var toastTimer = null;
  /** Small message at the top of the screen. kind: info | ok | warn | bad */
  function toast(message, kind) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast show ' + (kind || 'info');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.className = 'toast';
    }, 2800);
  }

  /* Show / hide button on every password box. It also works for screens that are drawn later. */
  (function addPasswordToggles() {
    if (!window.MutationObserver || !document.body) return;
    var style = document.createElement('style');
    style.textContent =
      '.pw-wrap{position:relative;display:block;width:100%}' +
      '.pw-wrap>input{width:100%;box-sizing:border-box;padding-right:46px}' +
      '.pw-toggle{position:absolute;top:50%;right:8px;transform:translateY(-50%);width:34px;height:34px;padding:0;border:0;border-radius:8px;background:transparent;color:inherit;opacity:.65;cursor:pointer;display:flex;align-items:center;justify-content:center}' +
      '.pw-toggle:hover,.pw-toggle:focus-visible{opacity:1}' +
      '.pw-toggle svg{width:20px;height:20px}';
    document.head.appendChild(style);

    var svgOpen = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
    var svgOff = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.9 10.9 0 0 1 12 19c-6.5 0-10-7-10-7a18.1 18.1 0 0 1 5.06-5.94M9.9 4.24A9.1 9.1 0 0 1 12 5c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';

    function decorate(input) {
      if (input.getAttribute('data-pw-ready')) return;
      input.setAttribute('data-pw-ready', '1');
      var wrap = document.createElement('span');
      wrap.className = 'pw-wrap';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'pw-toggle';
      button.setAttribute('aria-label', 'Show password');
      button.innerHTML = svgOpen;
      button.addEventListener('click', function () {
        var showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        button.innerHTML = showing ? svgOpen : svgOff;
        button.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
        input.focus();
      });
      wrap.appendChild(button);
    }

    function scan() {
      document.querySelectorAll('input[type="password"]').forEach(decorate);
    }
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    scan();
  })();

  window.Common = {
    esc: esc,
    peso: peso,
    timeOf: timeOf,
    dateTimeOf: dateTimeOf,
    getFoodImage: getFoodImage,
    api: api,
    estimateMinutes: estimateMinutes,
    beep: beep,
    toast: toast,
  };
})();