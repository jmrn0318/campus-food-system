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