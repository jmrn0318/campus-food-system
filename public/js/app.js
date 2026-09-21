/* Campus Pickup - student app
 * Flow: Menu -> Food details -> Cart -> Order summary -> Order tracking -> Pickup
 */
(function () {
  'use strict';

  const { esc, peso, timeOf, dateTimeOf, api, estimateMinutes, beep, toast } = window.Common;

  /* ---------------------------------------------------------------- */
  /* Settings                                                          */
  /* ---------------------------------------------------------------- */

  const PICKUP_POINT = 'Pickup counter, Canteen'; // change to your campus canteen name
  const TRACK_POLL_MS = 4000;
  const MENU_POLL_MS = 10000;
  const HISTORY_POLL_MS = 6000;
  const MAX_QTY = 10;

  const STATUS_INDEX = { received: 0, preparing: 1, ready: 2, completed: 3 };
  const STATUS_LABEL = {
    received: 'Order received',
    preparing: 'Preparing',
    ready: 'Ready for pickup',
    completed: 'Picked up',
  };
  const STATUS_TEXT = {
    received: {
      title: 'Order received',
      body: 'The stall has your order and will start on it soon.',
    },
    preparing: {
      title: 'Your food is being prepared',
      body: 'Feel free to do something else. Keep this page open and you will get an alert when it is ready.',
    },
    ready: {
      title: 'Ready for pickup',
      body: 'Show your pickup code at the ' + PICKUP_POINT + '.',
    },
    completed: {
      title: 'Picked up',
      body: 'Enjoy your meal!',
    },
  };

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        /* private mode etc. - app still works, it just will not remember */
      }
    },
  };

  let menu = [];
  let cart = store.get('cfs_cart', []); // [{ id, qty }]
  let orderIds = store.get('cfs_orders', []); // ids of orders placed on this phone
  let user = store.get('cfs_user', null);
  const menuFilter = { cat: 'All', q: '', availableOnly: false };

  const $view = document.getElementById('view');
  const $cartBar = document.getElementById('cart-bar');
  const $navCount = document.getElementById('nav-cart-count');

  let token = 0; // increases on every navigation so slow requests can't paint over a newer page
  let timers = [];
  const every = (fn, ms) => timers.push(setInterval(fn, ms));
  const clearTimers = () => {
    timers.forEach(clearInterval);
    timers = [];
  };

  /* ---------------------------------------------------------------- */
  /* Cart helpers                                                      */
  /* ---------------------------------------------------------------- */

  const findItem = (id) => menu.find((m) => m.id === id);
  const cartCount = () => cart.reduce((sum, l) => sum + l.qty, 0);
  const cartLines = () => cart.map((l) => ({ item: findItem(l.id), qty: l.qty })).filter((l) => l.item);
  const cartTotal = () => cartLines().reduce((sum, l) => sum + l.item.price * l.qty, 0);
  const categories = () => [...new Set(menu.map((m) => m.category))];
  const tintOf = (category) => Math.max(0, categories().indexOf(category)) % 5;

  function saveCart() {
    store.set('cfs_cart', cart);
    refreshChrome();
  }

  function addToCart(id, qty) {
    const line = cart.find((l) => l.id === id);
    if (line) line.qty = Math.min(line.qty + qty, MAX_QTY);
    else cart.push({ id, qty: Math.min(qty, MAX_QTY) });
    saveCart();
  }

  function setQty(id, qty) {
    if (qty <= 0) cart = cart.filter((l) => l.id !== id);
    else {
      const line = cart.find((l) => l.id === id);
      if (line) line.qty = Math.min(qty, MAX_QTY);
    }
    saveCart();
  }

  async function loadMenu() {
    const data = await api('/api/menu');
    menu = data.items;
    return menu;
  }

  /* ---------------------------------------------------------------- */
  /* Shared UI bits                                                    */
  /* ---------------------------------------------------------------- */

  const badge = (available) =>
    `<span class="badge ${available ? 'badge-ok' : 'badge-out'}">${available ? 'Available' : 'Sold out'}</span>`;

  const statusBadge = (status) => `<span class="status-pill status-${status}">${STATUS_LABEL[status]}</span>`;

  function stepperHtml(qty, label, id) {
    const idAttr = id ? ` data-id="${esc(id)}"` : '';
    return `<div class="stepper" role="group" aria-label="${esc(label)}">
      <button type="button" data-step="-1"${idAttr} aria-label="Decrease quantity"${qty <= 1 ? ' disabled' : ''}>&minus;</button>
      <output${id ? '' : ' id="qty-out"'} aria-live="polite">${qty}</output>
      <button type="button" data-step="1"${idAttr} aria-label="Increase quantity"${qty >= MAX_QTY ? ' disabled' : ''}>+</button>
    </div>`;
  }

  function renderError(message, retry) {
    $view.innerHTML = `<div class="empty">
      <h2>Can't load this right now</h2>
      <p>${esc(message)}</p>
      <button class="btn btn-primary" id="retry" type="button">Try again</button>
    </div>`;
    document.getElementById('retry').addEventListener('click', retry || router);
  }

  function refreshChrome() {
    const nav = document.querySelector('.bottom-nav');
    const alertsLink = document.getElementById('alerts-link');
    if (nav) nav.hidden = !user;
    if (alertsLink) alertsLink.hidden = !user;

    const count = cartCount();
    $navCount.textContent = count;
    $navCount.hidden = count === 0;

    const hash = location.hash || '#/';
    const browsing = /^#\/?$/.test(hash) || /^#\/item\//.test(hash);
    if (count > 0 && browsing) {
      const total = menu.length ? `<strong>${peso(cartTotal())}</strong>` : '';
      $cartBar.innerHTML = `<span class="cart-bar-count">${count}</span><span class="cart-bar-text">View cart</span>${total}`;
      $cartBar.hidden = false;
    } else {
      $cartBar.hidden = true;
    }

    let section = 'menu';
    if (/^#\/(cart|checkout)/.test(hash)) section = 'cart';
    else if (/^#\/(orders|track)/.test(hash)) section = 'orders';
    else if (/^#\/suggest$/.test(hash)) section = 'suggest';
    document.querySelectorAll('.nav-link').forEach((a) => {
      if (a.dataset.nav === section) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    const accountLink = document.getElementById('account-link');
    if (accountLink) {
      accountLink.textContent = user ? user.name.split(' ')[0] : 'Sign in';
      accountLink.href = user ? '#/account' : '#/login';
    }
  }

  function renderWelcome() {
    $view.innerHTML = `<section class="landing-hero">
      <div class="landing-copy"><p class="eyebrow">CAMPUS CANTEEN PICKUP</p><h1>Order ahead. Pick it up yourself.</h1><p class="landing-lede">Choose your meal from the canteen, see its estimated ready time, then collect it at the pickup counter without waiting in the ordering line.</p>
        <div class="landing-actions"><a class="btn btn-primary" href="#/login">Continue to customer access</a><a class="btn btn-ghost" href="/staff">Open staff portal</a></div>
      </div>
    </section><section class="landing-grid"><article><span class="feature-number">01</span><h2>Order online</h2><p>Check what is available, choose your food, and place your order before walking to the canteen.</p></article><article><span class="feature-number">02</span><h2>See your estimate</h2><p>Every order shows an estimated ready time based on preparation time and the current queue.</p></article><article><span class="feature-number">03</span><h2>Pick up yourself</h2><p>Come to the pickup counter when your order is ready and show your pickup code.</p></article></section>`;
  }

  function renderAuth(mode) {
    const forgot = mode === 'forgot';
    const register = mode === 'register';
    let step = 'form'; // 'form' first, then 'code' once we have emailed a 6-digit code
    let pendingEmail = '';
    let resendAt = 0;

    const headline = forgot ? 'Reset your access.' : register ? 'Create your canteen account.' : 'Sign in to order.';
    const lede = forgot
      ? 'Enter your email and we will send a 6-digit code to reset your password.'
      : register
        ? 'We will email a 6-digit code to confirm your address before your account is created.'
        : 'Your customer account lets you order online, track the estimated ready time, and view your pickup history.';

    $view.innerHTML = `<div class="auth-layout"><div class="auth-aside"><a class="back" href="#/welcome">Back to welcome</a><p class="eyebrow">CUSTOMER ACCESS</p><h1>${headline}</h1><p>${lede}</p></div><form class="form-card auth-card" id="auth-form"></form></div>`;
    const formEl = document.getElementById('auth-form');

    function draw() {
      if (step === 'code') {
        formEl.innerHTML = `<h2>${forgot ? 'Enter your reset code' : 'Verify your email'}</h2>
          <p class="hint">We sent a 6-digit code to <strong>${esc(pendingEmail)}</strong>. It expires in 10 minutes. Check your spam folder if you do not see it.</p>
          <label class="field"><span>6-digit code</span><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required /></label>
          ${forgot ? '<label class="field"><span>New password</span><input name="password" type="password" minlength="8" required autocomplete="new-password" /></label>' : ''}
          <button class="btn btn-primary btn-block" type="submit">${forgot ? 'Change password' : 'Verify and create account'}</button>
          <p class="auth-links"><a href="#" id="resend-code">Resend code</a><br /><a href="#" id="change-email">Use a different email</a></p>`;
        formEl.querySelector('input[name="code"]').focus();
        return;
      }
      formEl.innerHTML = `<h2>${forgot ? 'Forgot password' : register ? 'Register as customer' : 'Customer sign in'}</h2>
        ${register ? '<label class="field"><span>Name</span><input name="name" required autocomplete="name" /></label>' : ''}
        <label class="field"><span>Email</span><input name="email" type="email" required autocomplete="email" /></label>
        ${forgot ? '' : `<label class="field"><span>Password</span><input name="password" type="password" ${register ? 'minlength="8"' : ''} required autocomplete="${register ? 'new-password' : 'current-password'}" /></label>`}
        ${register ? '<p class="hint">Use at least 8 characters. We will email you a code to confirm your address.</p>' : ''}
        <button class="btn btn-primary btn-block" type="submit">${forgot ? 'Send reset code' : register ? 'Send verification code' : 'Sign in'}</button>
        <p class="auth-links">${forgot ? '<a href="#/login">Back to sign in</a>' : register ? 'Already registered? <a href="#/login">Sign in</a>' : '<a href="#/forgot">Forgot password?</a><br />New customer? <a href="#/register">Register</a>'}</p>`;
    }
    draw();

    formEl.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = Object.fromEntries(new FormData(formEl).entries());
      const button = formEl.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        if (step === 'code') {
          if (forgot) {
            await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ email: pendingEmail, code: form.code, password: form.password }) });
            toast('Password changed. Sign in with your new password.', 'ok');
          } else {
            await api('/api/auth/register/verify', { method: 'POST', body: JSON.stringify({ email: pendingEmail, code: form.code }) });
            toast('Email verified. Your account is ready. Sign in to continue.', 'ok');
          }
          location.hash = '#/login';
          return;
        }
        if (forgot) {
          const result = await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: form.email }) });
          pendingEmail = String(form.email).trim().toLowerCase();
          resendAt = Date.now() + 60000;
          step = 'code';
          draw();
          toast(result.message, 'ok');
          return;
        }
        if (register) {
          const result = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(form) });
          pendingEmail = result.email;
          resendAt = Date.now() + 60000;
          step = 'code';
          draw();
          toast(result.message, 'ok');
          return;
        }
        const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(form) });
        store.set('cfs_token', result.token);
        user = result.user;
        store.set('cfs_user', user);
        refreshChrome();
        location.hash = '#/';
      } catch (error) {
        toast(error.message, 'bad');
      } finally {
        button.disabled = false;
      }
    });

    formEl.addEventListener('click', async (event) => {
      const link = event.target.closest('a');
      if (!link) return;
      if (link.id === 'change-email') {
        event.preventDefault();
        step = 'form';
        draw();
        return;
      }
      if (link.id === 'resend-code') {
        event.preventDefault();
        if (Date.now() < resendAt) {
          toast('Please wait a minute before asking for another code.', 'warn');
          return;
        }
        try {
          const result = await api(forgot ? '/api/auth/forgot-password' : '/api/auth/register/resend', { method: 'POST', body: JSON.stringify({ email: pendingEmail }) });
          resendAt = Date.now() + 60000;
          toast(result.message, 'ok');
        } catch (error) {
          toast(error.message, 'bad');
        }
      }
    });
  }

  function renderAccount() {
    $view.innerHTML = `<div class="page-head"><p class="eyebrow">YOUR CAMPUS PROFILE</p><h1>${esc(user.name)}</h1><p class="sub">${esc(user.email)}</p></div><section class="form-card account-card"><div class="account-role"><span>Account type</span><strong>Student account</strong></div><p class="hint">Your orders, alerts, and menu suggestions are kept in your student space.</p><button class="btn btn-ghost btn-block" id="sign-out" type="button">Sign out</button></section>`;
    document.getElementById('sign-out').addEventListener('click', async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch (error) { /* local session still clears */ }
      store.set('cfs_token', null);
      store.set('cfs_user', null);
      user = null;
      refreshChrome();
      location.hash = '#/welcome';
    });
  }

  async function renderNotifications() {
    try {
      const { notifications } = await api('/api/notifications');
      $view.innerHTML = `<div class="page-head"><h1>Notifications</h1><p class="sub">Order updates and canteen news in one place.</p></div><div class="notification-list">${notifications.length ? notifications.map((note) => `<article class="notification ${note.read ? '' : 'is-new'}"><span class="notification-mark">${note.type === 'order' ? '↗' : '✦'}</span><div><strong>${esc(note.title)}</strong><p>${esc(note.message)}</p><small>${dateTimeOf(note.createdAt)}</small></div></article>`).join('') : '<div class="empty"><h2>You are all caught up</h2><p>New order and canteen updates will appear here.</p></div>'}</div>`;
    } catch (error) { renderError(error.message, router); }
  }

  function renderSuggest() {
    $view.innerHTML = `<div class="page-head"><p class="eyebrow">MENU LAB</p><h1>Suggest the next favorite.</h1><p class="sub">Tell the kitchen what you would actually order.</p></div><form class="form-card" id="suggest-form"><label class="field"><span>Your name <em>(optional)</em></span><input name="customerName" value="${esc(user ? user.name : '')}" /></label><label class="field"><span>Food idea</span><input name="foodName" required placeholder="e.g. Chicken katsu rice" /></label><label class="field"><span>Category</span><select name="category"><option>Rice Meals</option><option>Noodles & Snacks</option><option>Drinks</option><option>Desserts</option></select></label><label class="field"><span>Why would students love it?</span><textarea name="reason" required rows="4" maxlength="300"></textarea></label><button class="btn btn-primary btn-block" type="submit">Send suggestion</button></form>`;
    document.getElementById('suggest-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try { await api('/api/suggestions', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) }); toast('Suggestion sent to the canteen team.', 'ok'); event.currentTarget.reset(); } catch (error) { toast(error.message, 'bad'); }
    });
  }

  /* ---------------------------------------------------------------- */
  /* 1. Menu                                                           */
  /* ---------------------------------------------------------------- */

  function foodVisual(item) {
    const image = item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="" onerror="this.hidden=true" />` : '';
    return image;
  }

  function foodCard(m) {
    return `<a class="food-card${m.available ? '' : ' is-out'}" href="#/item/${esc(m.id)}">
      <span class="food-thumb tint-${tintOf(m.category)}" aria-hidden="true">${foodVisual(m)}</span>
      <span class="food-info">
        <span class="food-name">${esc(m.name)}</span>
        <span class="food-desc">${esc(m.description)}</span>
        <span class="food-row">
          <strong class="price">${peso(m.price)}</strong>
          <span class="prep">about ${m.prepMinutes} min</span>
          ${badge(m.available)}
        </span>
      </span>
    </a>`;
  }

  function paintChips() {
    const chips = document.getElementById('chips');
    if (!chips) return;
    if (!chips.childElementCount) {
      chips.innerHTML =
        ['All', ...categories()]
          .map((c) => `<button type="button" class="chip" data-cat="${esc(c)}">${esc(c)}</button>`)
          .join('') + `<button type="button" class="chip chip-toggle" data-toggle="available">Available only</button>`;
    }
    chips.querySelectorAll('[data-cat]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.cat === menuFilter.cat));
    });
    const toggle = chips.querySelector('[data-toggle]');
    if (toggle) toggle.setAttribute('aria-pressed', String(menuFilter.availableOnly));
  }

  function paintMenu() {
    const list = document.getElementById('menu-list');
    const summary = document.getElementById('menu-summary');
    if (!list) return;

    const availableCount = menu.filter((m) => m.available).length;
    summary.textContent = `${availableCount} of ${menu.length} items available right now`;
    paintChips();

    const q = menuFilter.q.trim().toLowerCase();
    const shown = menu.filter(
      (m) =>
        (menuFilter.cat === 'All' || m.category === menuFilter.cat) &&
        (!menuFilter.availableOnly || m.available) &&
        (!q || `${m.name} ${m.description}`.toLowerCase().includes(q))
    );

    list.innerHTML = shown.length
      ? shown.map(foodCard).join('')
      : `<div class="empty"><h2>No matches</h2><p>Try a different word, or clear the filters.</p></div>`;
  }

  async function renderMenu() {
    const t = token;
    $view.innerHTML = `
      <div class="page-head">
        <h1>Canteen menu</h1>
        <p class="sub" id="menu-summary">Checking what is available…</p>
      </div>
      <label class="search">
        <span class="sr-only">Search the menu</span>
        <input id="search" type="search" placeholder="Search food or drinks" autocomplete="off" value="${esc(menuFilter.q)}" />
      </label>
      <div class="chips" id="chips" role="group" aria-label="Filter the menu"></div>
      <div class="menu-grid" id="menu-list" aria-live="polite"></div>`;

    document.getElementById('search').addEventListener('input', (e) => {
      menuFilter.q = e.target.value;
      paintMenu();
    });
    document.getElementById('chips').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.cat) menuFilter.cat = btn.dataset.cat;
      if (btn.dataset.toggle) menuFilter.availableOnly = !menuFilter.availableOnly;
      paintMenu();
    });

    if (menu.length) paintMenu(); // show what we already know while refreshing
    try {
      await loadMenu();
    } catch (err) {
      if (t !== token) return;
      if (!menu.length) return renderError(err.message, router);
    }
    if (t !== token) return;
    paintMenu();
    refreshChrome();

    // Keep availability live while the student is browsing
    every(async () => {
      try {
        const before = JSON.stringify(menu);
        await loadMenu();
        if (t === token && JSON.stringify(menu) !== before) {
          paintMenu();
          refreshChrome();
        }
      } catch (e) {
        /* try again next time */
      }
    }, MENU_POLL_MS);
  }

  /* ---------------------------------------------------------------- */
  /* 2. Food details                                                   */
  /* ---------------------------------------------------------------- */

  async function renderItem(id) {
    const t = token;
    try {
      await loadMenu();
    } catch (err) {
      if (t !== token) return;
      if (!menu.length) return renderError(err.message, router);
    }
    if (t !== token) return;

    const item = findItem(id);
    if (!item) {
      $view.innerHTML = `<a class="back" href="#/">Back to menu</a>
        <div class="empty"><h2>We can't find that item</h2><p>It may have been removed from the menu.</p>
        <a class="btn btn-primary" href="#/">See the menu</a></div>`;
      return;
    }

    const inCart = (cart.find((l) => l.id === id) || {}).qty || 0;
    let qty = 1;

    const orderBlock = item.available
      ? `<div class="qty-row"><span>Quantity</span>${stepperHtml(qty, `Quantity of ${item.name}`)}</div>
         <button class="btn btn-primary btn-block btn-split" id="add-btn" type="button">
           <span>Add to cart</span><span id="add-price">${peso(item.price * qty)}</span>
         </button>`
      : `<div class="notice notice-out"><strong>Sold out for now.</strong> The stall has run out of this item. Pick something else from the menu.</div>
         <a class="btn btn-ghost btn-block" href="#/">Browse the menu</a>`;

    $view.innerHTML = `
      <a class="back" href="#/">Back to menu</a>
      <article class="detail">
        <div class="detail-hero tint-${tintOf(item.category)}${item.available ? '' : ' is-out'}" aria-hidden="true">${foodVisual(item)}</div>
        <div class="detail-body">
          <div class="detail-title">
            <h1>${esc(item.name)}</h1>
            <strong class="price price-lg">${peso(item.price)}</strong>
          </div>
          <p class="detail-desc">${esc(item.description)}</p>
          <dl class="facts">
            <div><dt>Availability</dt><dd>${badge(item.available)}</dd></div>
            <div><dt>Preparation time</dt><dd>About ${item.prepMinutes} min</dd></div>
            <div><dt>Category</dt><dd>${esc(item.category)}</dd></div>
          </dl>
          ${inCart ? `<p class="hint">You already have ${inCart} in your cart.</p>` : ''}
          ${orderBlock}
        </div>
      </article>`;

    if (!item.available) return;

    const out = document.getElementById('qty-out');
    const price = document.getElementById('add-price');
    const stepper = $view.querySelector('.stepper');
    const sync = () => {
      out.textContent = qty;
      price.textContent = peso(item.price * qty);
      stepper.querySelector('[data-step="-1"]').disabled = qty <= 1;
      stepper.querySelector('[data-step="1"]').disabled = qty >= MAX_QTY;
    };
    stepper.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      qty = Math.min(MAX_QTY, Math.max(1, qty + Number(btn.dataset.step)));
      sync();
    });
    document.getElementById('add-btn').addEventListener('click', () => {
      addToCart(item.id, qty);
      toast(`Added ${qty} × ${item.name} to your cart`, 'ok');
      location.hash = '#/';
    });
  }

  /* ---------------------------------------------------------------- */
  /* 3. Cart                                                           */
  /* ---------------------------------------------------------------- */

  function paintCart(focusSelector) {
    const lines = cartLines();
    if (!lines.length) {
      $view.innerHTML = `<div class="page-head"><h1>Your cart</h1></div>
        <div class="empty"><h2>Your cart is empty</h2><p>Pick something from the menu to get started.</p>
        <a class="btn btn-primary" href="#/">See the menu</a></div>`;
      return;
    }

    const soldOut = lines.filter((l) => !l.item.available);
    const rows = lines
      .map(({ item, qty }) => {
        const out = !item.available;
        return `<li class="cart-line${out ? ' is-out' : ''}">
          <span class="food-thumb tint-${tintOf(item.category)}" aria-hidden="true">${foodVisual(item)}</span>
          <div class="cart-main">
            <span class="food-name">${esc(item.name)}</span>
            <span class="prep">${peso(item.price)} each</span>
            ${out ? `<span class="badge badge-out">Sold out</span>` : ''}
            <div class="cart-controls">
              ${out ? '' : stepperHtml(qty, `Quantity of ${item.name}`, item.id)}
              <button type="button" class="link-btn" data-remove="${esc(item.id)}">Remove</button>
            </div>
          </div>
          <strong class="cart-price">${out ? '' : peso(item.price * qty)}</strong>
        </li>`;
      })
      .join('');

    $view.innerHTML = `
      <div class="page-head"><h1>Your cart</h1><p class="sub">${cartCount()} item${cartCount() === 1 ? '' : 's'}</p></div>
      <ul class="cart-list">${rows}</ul>
      <div class="summary-card">
        <div class="total-row"><span>Total</span><strong>${peso(cartTotal())}</strong></div>
        ${
          soldOut.length
            ? `<div class="notice notice-out">Remove the sold-out items to continue.</div>
               <button class="btn btn-primary btn-block" type="button" disabled>Review order</button>`
            : `<a class="btn btn-primary btn-block" href="#/checkout">Review order</a>`
        }
        <a class="btn btn-ghost btn-block" href="#/">Add more food</a>
      </div>`;

    $view.querySelector('.cart-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      let focus = null;
      if (btn.dataset.remove) {
        setQty(btn.dataset.remove, 0);
      } else if (btn.dataset.step) {
        const line = cart.find((l) => l.id === btn.dataset.id);
        if (line) setQty(line.id, line.qty + Number(btn.dataset.step));
        focus = `[data-step="${btn.dataset.step}"][data-id="${btn.dataset.id}"]`;
      }
      paintCart(focus);
    });

    if (focusSelector) {
      const el = $view.querySelector(focusSelector);
      if (el && !el.disabled) el.focus();
    }
  }

  async function renderCart() {
    const t = token;
    try {
      await loadMenu();
    } catch (err) {
      if (t !== token) return;
      if (!menu.length) return renderError(err.message, router);
    }
    if (t !== token) return;
    const before = cart.length;
    cart = cart.filter((l) => findItem(l.id)); // drop items removed from the menu
    if (cart.length !== before) saveCart();
    paintCart();
  }

  /* ---------------------------------------------------------------- */
  /* 4. Order summary (checkout)                                       */
  /* ---------------------------------------------------------------- */

  async function renderCheckout() {
    const t = token;
    let queueDelay = 0;
    try {
      const [, queue] = await Promise.all([loadMenu(), api('/api/queue')]);
      queueDelay = queue.queueDelayMinutes;
    } catch (err) {
      if (t !== token) return;
      if (!menu.length) return renderError(err.message, router);
    }
    if (t !== token) return;

    cart = cart.filter((l) => findItem(l.id));
    saveCart();
    const lines = cartLines();
    if (!lines.length) {
      location.hash = '#/cart';
      return;
    }
    if (lines.some((l) => !l.item.available)) {
      toast('Some items just sold out. Update your cart first.', 'warn');
      location.hash = '#/cart';
      return;
    }

    const minutes = estimateMinutes(
      lines.map((l) => ({ prepMinutes: l.item.prepMinutes, qty: l.qty })),
      queueDelay
    );
    const readyAt = new Date(Date.now() + minutes * 60000).toISOString();
    const total = cartTotal();
    const savedName = user?.name || '';
    store.set('cfs_name', null);

    $view.innerHTML = `
      <a class="back" href="#/cart">Back to cart</a>
      <div class="page-head"><h1>Order summary</h1><p class="sub">Check everything before you place your order.</p></div>

      <section class="summary-card" aria-label="Items">
        <ul class="summary-list">
          ${lines
            .map(
              ({ item, qty }) => `<li>
                <span>${qty} × ${esc(item.name)}</span><span>${peso(item.price * qty)}</span></li>`
            )
            .join('')}
        </ul>
        <div class="total-row"><span>Total</span><strong>${peso(total)}</strong></div>
      </section>

      <section class="summary-card" aria-label="Pickup information">
        <dl class="facts facts-stack">
          <div><dt>Pick up at</dt><dd>${esc(PICKUP_POINT)}</dd></div>
          <div><dt>Estimated ready</dt><dd>Around ${timeOf(readyAt)} (about ${minutes} min)</dd></div>
          <div><dt>Payment</dt><dd>Pay at the counter when you pick up</dd></div>
        </dl>
      </section>

      <form id="order-form" class="form-card" novalidate>
        <label class="field">
          <span>Your name</span>
          <input id="name" name="name" type="text" maxlength="40" autocomplete="given-name" required value="${esc(savedName)}" placeholder="So the stall can call your order" />
        </label>
        <label class="field">
          <span>Note for the stall <em>(optional)</em></span>
          <textarea id="note" name="note" maxlength="120" rows="2" placeholder="Example: no onions, extra rice"></textarea>
        </label>
        <button class="btn btn-primary btn-block btn-split" id="place-btn" type="submit">
          <span id="place-label">Place order</span><span>${peso(total)}</span>
        </button>
      </form>`;

    const form = document.getElementById('order-form');
    const nameInput = document.getElementById('name');
    const placeBtn = document.getElementById('place-btn');
    const placeLabel = document.getElementById('place-label');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) {
        toast('Enter your name so the stall knows whose order it is.', 'warn');
        nameInput.focus();
        return;
      }
      placeBtn.disabled = true;
      placeLabel.textContent = 'Placing order…';
      try {
        const { order } = await api('/api/orders', {
          method: 'POST',
          body: JSON.stringify({
            customerName: name,
            note: document.getElementById('note').value.trim(),
            items: cart.map((l) => ({ id: l.id, qty: l.qty })),
          }),
        });
        store.set('cfs_name', name);
        orderIds = [order.id, ...orderIds.filter((x) => x !== order.id)].slice(0, 30);
        store.set('cfs_orders', orderIds);
        cart = [];
        saveCart();
        location.hash = `#/track/${order.id}`;
      } catch (err) {
        toast(err.message, 'bad');
        placeBtn.disabled = false;
        placeLabel.textContent = 'Place order';
        if (err.status === 409) location.hash = '#/cart';
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* 5. Order tracking                                                 */
  /* ---------------------------------------------------------------- */

  function trackHtml(order) {
    const idx = STATUS_INDEX[order.status];
    const stepKeys = ['received', 'preparing', 'ready'];
    const stepLabels = ['Ordered', 'Preparing', 'Ready'];
    const waiting = order.status === 'received' || order.status === 'preparing';

    const steps = stepLabels
      .map((label, i) => {
        const state = i < idx ? 'done' : i === idx ? 'current' : 'todo';
        const entry = order.history.find((h) => h.status === stepKeys[i]);
        const check = state === 'done' || (order.status === 'ready' && i === 2);
        const sr = state === 'done' ? ' (done)' : state === 'current' ? ' (current step)' : ' (not yet)';
        return `<li class="step ${state}"${state === 'current' ? ' aria-current="step"' : ''}>
          <span class="dot" aria-hidden="true">${check ? '&#10003;' : ''}</span>
          <span class="step-label">${label}<span class="sr-only">${sr}</span></span>
          <span class="step-time">${entry ? timeOf(entry.at) : '&nbsp;'}</span>
        </li>`;
      })
      .join('');

    const minsLeft = Math.max(0, Math.ceil((new Date(order.estimatedReadyAt) - Date.now()) / 60000));
    const eta = `Around ${timeOf(order.estimatedReadyAt)}${minsLeft > 0 ? `, about ${minsLeft} min from now` : ', any moment now'}`;
    const ahead =
      order.ordersAhead === 0
        ? 'Yours is next in line'
        : `${order.ordersAhead} order${order.ordersAhead === 1 ? '' : 's'} ahead of yours`;

    const facts = [
      waiting ? `<div><dt>Estimated ready</dt><dd>${eta}</dd></div>` : '',
      waiting ? `<div><dt>Queue</dt><dd>${ahead}</dd></div>` : '',
      `<div><dt>Pick up at</dt><dd>${esc(PICKUP_POINT)}</dd></div>`,
      `<div><dt>Payment</dt><dd>Pay at the counter</dd></div>`,
    ].join('');

    const items = order.items
      .map((l) => `<li><span>${l.qty} × ${esc(l.name)}</span><span>${peso(l.price * l.qty)}</span></li>`)
      .join('');

    const canAlert = 'Notification' in window && Notification.permission === 'default' && order.status !== 'completed';

    return `
      <a class="back" href="#/orders">My orders</a>
      <article class="ticket${order.status === 'ready' ? ' is-ready' : ''}">
        <div class="ticket-top">
          <p class="ticket-label">Pickup code</p>
          <p class="ticket-code" aria-label="Pickup code ${esc(order.code)}">${esc(order.code)}</p>
          <p class="ticket-name">Order for ${esc(order.customerName)}</p>
        </div>
        <div class="ticket-tear" aria-hidden="true"></div>
        <div class="ticket-body">
          <ol class="steps" aria-label="Order progress">${steps}</ol>
          <div class="status-msg" aria-live="polite">
            <h2>${STATUS_TEXT[order.status].title}</h2>
            <p>${STATUS_TEXT[order.status].body}</p>
          </div>
          <dl class="facts facts-stack">${facts}</dl>
          <ul class="summary-list">${items}</ul>
          <div class="total-row"><span>Total</span><strong>${peso(order.total)}</strong></div>
          ${order.note ? `<p class="hint">Your note: ${esc(order.note)}</p>` : ''}
          ${canAlert ? `<button class="btn btn-ghost btn-block" id="alert-btn" type="button">Alert me when it is ready</button>` : ''}
          <a class="btn ${order.status === 'completed' ? 'btn-primary' : 'btn-ghost'} btn-block" href="#/">${order.status === 'completed' ? 'Order again' : 'Back to menu'}</a>
        </div>
      </article>`;
  }

  function notifyReady(order) {
    toast(`Order ${order.code} is ready for pickup!`, 'ok');
    beep();
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification('Your order is ready', { body: `Show code ${order.code} at the ${PICKUP_POINT}.` });
      } catch (e) {
        /* some browsers only allow notifications from a service worker */
      }
    }
  }

  async function renderTrack(id) {
    const t = token;
    let order;
    try {
      order = (await api(`/api/orders/${encodeURIComponent(id)}`)).order;
    } catch (err) {
      if (t !== token) return;
      if (err.status === 404) {
        $view.innerHTML = `<a class="back" href="#/orders">My orders</a>
          <div class="empty"><h2>Order not found</h2><p>This order may be too old, or the link is incorrect.</p>
          <a class="btn btn-primary" href="#/">Back to menu</a></div>`;
        return;
      }
      if (err.status === 401) {
        store.set('cfs_token', null);
        store.set('cfs_user', null);
        user = null;
        refreshChrome();
        location.hash = '#/login';
        return;
      }
      return renderError('Your order history could not be loaded. Please try again.', router);
    }
    if (t !== token) return;

    let lastStatus = order.status;
    let lastHtml = '';

    const paint = (o) => {
      const html = trackHtml(o);
      if (html === lastHtml) return;
      lastHtml = html;
      $view.innerHTML = html;
      const alertBtn = document.getElementById('alert-btn');
      if (alertBtn) {
        alertBtn.addEventListener('click', async () => {
          try {
            const result = await Notification.requestPermission();
            toast(result === 'granted' ? 'Alerts are on for this browser.' : 'Alerts are blocked in your browser settings.', result === 'granted' ? 'ok' : 'warn');
          } catch (e) {
            /* ignore */
          }
          paint(o);
        });
      }
    };

    paint(order);
    if (order.status === 'completed') return;

    every(async () => {
      try {
        const { order: fresh } = await api(`/api/orders/${encodeURIComponent(id)}`);
        if (t !== token) return;
        if (fresh.status !== lastStatus) {
          lastStatus = fresh.status;
          if (fresh.status === 'ready') notifyReady(fresh);
          else if (fresh.status === 'preparing') toast('The stall started preparing your order.', 'info');
        }
        paint(fresh);
        if (fresh.status === 'completed') clearTimers();
      } catch (e) {
        /* keep the last known status on screen and try again */
      }
    }, TRACK_POLL_MS);
  }

  /* ---------------------------------------------------------------- */
  /* 6. Order history                                                  */
  /* ---------------------------------------------------------------- */

  function historyHtml(list) {
    if (!list.length) {
      return `<div class="page-head"><h1>My orders</h1></div>
        <div class="empty"><h2>No orders yet</h2><p>Orders you place on this phone will show up here.</p>
        <a class="btn btn-primary" href="#/">See the menu</a></div>`;
    }
    const rows = list
      .map((o) => {
        const count = o.items.reduce((s, l) => s + l.qty, 0);
        const first = o.items[0] ? o.items[0].name : '';
        const more = o.items.length > 1 ? ` and ${o.items.length - 1} more` : '';
        return `<li><a class="history-item" href="#/track/${esc(o.id)}">
          <span class="history-code">${esc(o.code)}</span>
          <span class="history-main">
            <span class="food-name">${esc(first)}${more}</span>
            <span class="prep">${count} item${count === 1 ? '' : 's'}, ${dateTimeOf(o.createdAt)}</span>
          </span>
          <span class="history-side"><strong>${peso(o.total)}</strong>${statusBadge(o.status)}</span>
        </a></li>`;
      })
      .join('');
    return `<div class="page-head"><h1>My orders</h1><p class="sub">Tap an order to see its progress.</p></div>
      <ul class="history-list">${rows}</ul>`;
  }

  async function renderHistory() {
    const t = token;
    if (!orderIds.length) {
      $view.innerHTML = historyHtml([]);
      return;
    }
    let lastHtml = '';
    const load = async () => {
      const { orders } = await api(`/api/orders?ids=${orderIds.map(encodeURIComponent).join(',')}`);
      if (t !== token) return;
      orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const html = historyHtml(orders);
      if (html !== lastHtml) {
        lastHtml = html;
        $view.innerHTML = html;
      }
    };
    try {
      await load();
    } catch (err) {
      if (t !== token) return;
      return renderError(err.message, router);
    }
    every(() => load().catch(() => {}), HISTORY_POLL_MS);
  }

  /* ---------------------------------------------------------------- */
  /* Router                                                            */
  /* ---------------------------------------------------------------- */

  const routes = [
    [/^#\/welcome$/, renderWelcome],
    [/^#\/login$/, () => renderAuth('login')],
    [/^#\/register$/, () => renderAuth('register')],
    [/^#\/forgot$/, () => renderAuth('forgot')],
    [/^#\/account$/, renderAccount],
    [/^#\/notifications$/, renderNotifications],
    [/^#\/suggest$/, renderSuggest],
    [/^#\/?$/, renderMenu],
    [/^#\/item\/([\w-]+)$/, renderItem],
    [/^#\/cart$/, renderCart],
    [/^#\/checkout$/, renderCheckout],
    [/^#\/track\/([\w-]+)$/, renderTrack],
    [/^#\/orders$/, renderHistory],
  ];

  function router() {
    token += 1;
    clearTimers();
    const hash = location.hash || '#/';
    const publicHashes = ['#/welcome', '#/login', '#/register', '#/forgot'];
    if (!user && !publicHashes.includes(hash)) {
      location.hash = hash === '#/' ? '#/welcome' : '#/login';
      return;
    }
    for (const [pattern, handler] of routes) {
      const match = hash.match(pattern);
      if (match) {
        Promise.resolve(handler(...match.slice(1))).catch((err) => renderError(err.message, router));
        window.scrollTo(0, 0);
        refreshChrome();
        return;
      }
    }
    location.hash = '#/';
  }

  window.addEventListener('hashchange', router);
  (async function init() {
    const savedToken = store.get('cfs_token', null);
    if (savedToken) {
      try {
        const result = await api('/api/auth/me');
        user = result.user;
        store.set('cfs_user', user);
      } catch (error) {
        store.set('cfs_token', null);
        store.set('cfs_user', null);
        user = null;
      }
    } else {
      user = null;
    }
    refreshChrome();
    router();
  })();
})();