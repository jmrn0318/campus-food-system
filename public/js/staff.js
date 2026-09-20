/* Campus Pickup - staff board
 * Staff can: see incoming orders, move them Received -> Preparing -> Ready -> Picked up,
 * and mark menu items as sold out / available again.
 */
(function () {
  'use strict';

  const { esc, peso, timeOf, api, beep, toast } = window.Common;

  const POLL_MS = 4000;

  const $root = document.getElementById('staff-root');
  const $logout = document.getElementById('logout-btn');

  let pin = '';
  let staffToken = '';
  try {
    pin = sessionStorage.getItem('cfs_staff_pin') || '';
    staffToken = sessionStorage.getItem('cfs_staff_token') || '';
  } catch (e) {
    /* ignore */
  }

  let pollTimer = null;
  let knownIds = null; // ids we've already seen, so we only beep for genuinely new orders
  let lastOrdersHtml = '';
  let serverOffset = 0; // server clock minus this device's clock, in ms
  let menuItems = [];

  const staffApi = (path, options) =>
    api(path, Object.assign({}, options, { headers: { 'x-staff-pin': pin, ...(staffToken ? { Authorization: `Bearer ${staffToken}` } : {}) } }));

  /* ---------------------------------------------------------------- */
  /* Sign in / out                                                     */
  /* ---------------------------------------------------------------- */

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function showLogin(message, mode = 'login') {
    const register = mode === 'register';
    const forgot = mode === 'forgot';
    stopPolling();
    knownIds = null;
    lastOrdersHtml = '';
    $logout.hidden = true;
    $root.innerHTML = `
      <div class="staff-auth"><a class="back" href="/">Back to welcome</a><p class="eyebrow">STAFF PORTAL</p><h1>${register ? 'Create a verified staff account.' : forgot ? 'Reset staff access.' : 'Staff sign in.'}</h1><p class="sub">${register ? 'Registration requires the private verification code issued by the canteen administrator.' : forgot ? 'Enter your staff email to request password reset instructions.' : 'Use your verified staff email and password to open the operations board.'}</p>
      <form class="form-card login-card" id="login-form">
        <h2>${register ? 'Register staff account' : forgot ? 'Forgot password' : 'Sign in to staff portal'}</h2>
        ${message ? `<div class="notice notice-out">${esc(message)}</div>` : ''}
        ${register ? '<label class="field"><span>Name</span><input id="staff-name" type="text" autocomplete="name" required /></label>' : ''}
        <label class="field"><span>Staff email</span><input id="staff-email" type="email" autocomplete="email" required /></label>
        ${forgot ? '' : '<label class="field"><span>Password</span><input id="staff-password" type="password" minlength="6" autocomplete="current-password" required /></label>'}
        ${register ? '<label class="field"><span>Staff verification code</span><input id="staff-code" type="password" autocomplete="off" required /></label>' : ''}
        <button class="btn btn-primary btn-block" type="submit">${register ? 'Register staff account' : forgot ? 'Send reset instructions' : 'Sign in'}</button>
        <p class="auth-links">${forgot ? '<a href="#" id="show-staff-login">Back to sign in</a>' : register ? 'Already verified? <a href="#" id="show-staff-login">Sign in</a>' : '<a href="#" id="show-staff-forgot">Forgot password?</a><br />New staff member? <a href="#" id="show-staff-register">Register with verification code</a>'}</p>
      </form></div>`;
    const input = document.getElementById(register ? 'staff-name' : 'staff-email');
    input.focus();
    const switchLink = document.getElementById(forgot || register ? 'show-staff-login' : 'show-staff-register');
    switchLink.addEventListener('click', (event) => { event.preventDefault(); showLogin('', forgot || register ? 'login' : 'register'); });
    const forgotLink = document.getElementById('show-staff-forgot');
    if (forgotLink) forgotLink.addEventListener('click', (event) => { event.preventDefault(); showLogin('', 'forgot'); });
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const body = {
          name: document.getElementById('staff-name')?.value,
          email: document.getElementById('staff-email').value,
          password: document.getElementById('staff-password').value,
          inviteCode: document.getElementById('staff-code')?.value,
        };
        if (forgot) {
          const result = await api('/api/auth/staff/forgot-password', { method: 'POST', body: JSON.stringify({ email: body.email }) });
          toast(result.message, 'ok');
          return;
        }
        const result = await api(`/api/auth/staff/${register ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(body) });
        if (register) return showLogin('Staff account created. Sign in to continue.', 'login');
        staffToken = result.token;
        try {
          sessionStorage.setItem('cfs_staff_token', staffToken);
        } catch (err) {
          /* ignore */
        }
        showBoard();
      } catch (err) {
        showLogin(err.message, mode);
      }
    });
  }

  function logout(message) {
    pin = '';
    staffToken = '';
    try {
      sessionStorage.removeItem('cfs_staff_pin');
      sessionStorage.removeItem('cfs_staff_token');
    } catch (e) {
      /* ignore */
    }
    showLogin(message);
  }

  $logout.addEventListener('click', () => logout());

  /* ---------------------------------------------------------------- */
  /* Board shell                                                       */
  /* ---------------------------------------------------------------- */

  function showBoard() {
    $logout.hidden = false;
    $root.innerHTML = `
      <div class="board-head">
        <div>
          <h1>Order board</h1>
          <p class="sub" id="updated">Loading orders…</p>
        </div>
        <div class="tabs" role="tablist" aria-label="Staff sections">
          <button type="button" role="tab" id="tab-orders" aria-selected="true" aria-controls="panel-orders" data-tab="orders">Orders</button>
          <button type="button" role="tab" id="tab-menu" aria-selected="false" aria-controls="panel-menu" data-tab="menu">Food management</button>
          <button type="button" role="tab" id="tab-ideas" aria-selected="false" aria-controls="panel-ideas" data-tab="ideas">Student ideas</button>
          <button type="button" role="tab" id="tab-profile" aria-selected="false" aria-controls="panel-profile" data-tab="profile">My profile</button>
        </div>
      </div>
      <section id="panel-orders" role="tabpanel" aria-labelledby="tab-orders">
        <div class="board" id="board"></div>
        <div id="done-wrap"></div>
      </section>
      <section id="panel-menu" role="tabpanel" aria-labelledby="tab-menu" hidden>
        <div id="menu-panel"><p class="sub">Loading menu…</p></div>
      </section>`;
    $root.insertAdjacentHTML('beforeend', '<section id="panel-ideas" role="tabpanel" aria-labelledby="tab-ideas" hidden><div id="ideas-panel"><p class="sub">Loading student ideas…</p></div></section><section id="panel-profile" role="tabpanel" aria-labelledby="tab-profile" hidden><div id="profile-panel"><p class="sub">Loading profile…</p></div></section>');

    lastOrdersHtml = '';
    knownIds = null;
    refreshOrders();
    stopPolling();
    pollTimer = setInterval(refreshOrders, POLL_MS);
  }

  function selectTab(name) {
    document.querySelectorAll('[role="tab"]').forEach((t) => {
      t.setAttribute('aria-selected', String(t.dataset.tab === name));
    });
    document.getElementById('panel-orders').hidden = name !== 'orders';
    document.getElementById('panel-menu').hidden = name !== 'menu';
    document.getElementById('panel-ideas').hidden = name !== 'ideas';
    document.getElementById('panel-profile').hidden = name !== 'profile';
    if (name === 'menu') loadMenuPanel();
    if (name === 'ideas') loadIdeasPanel();
    if (name === 'profile') loadProfilePanel();
  }

  /* ---------------------------------------------------------------- */
  /* Orders                                                            */
  /* ---------------------------------------------------------------- */

  const COLUMNS = [
    {
      status: 'received',
      title: 'New',
      empty: 'No new orders right now.',
      action: { label: 'Start preparing', to: 'preparing' },
      back: null,
    },
    {
      status: 'preparing',
      title: 'Preparing',
      empty: 'Nothing being prepared.',
      action: { label: 'Mark ready', to: 'ready' },
      back: { label: 'Back to new', to: 'received' },
    },
    {
      status: 'ready',
      title: 'Ready for pickup',
      empty: 'No orders waiting for pickup.',
      action: { label: 'Mark picked up', to: 'completed' },
      back: { label: 'Back to preparing', to: 'preparing' },
    },
  ];

  function orderCard(o, col, now) {
    const minutes = Math.max(0, Math.floor((now - new Date(o.createdAt).getTime()) / 60000));
    const items = o.items
      .map((l) => `<li><span>${l.qty} × ${esc(l.name)}</span><span>${peso(l.price * l.qty)}</span></li>`)
      .join('');
    return `<article class="order-card order-${o.status}">
      <header class="order-head">
        <strong class="order-code">${esc(o.code)}</strong>
        <span class="order-name">${esc(o.customerName)}</span>
        <span class="order-wait">${minutes < 1 ? 'Just now' : minutes + ' min ago'}</span>
      </header>
      <ul class="summary-list">${items}</ul>
      ${o.note ? `<p class="order-note"><strong>Note:</strong> ${esc(o.note)}</p>` : ''}
      <div class="order-foot">
        <span>Total <strong>${peso(o.total)}</strong></span>
        <span>Promised by ${timeOf(o.estimatedReadyAt)}</span>
      </div>
      <div class="order-actions">
        <button type="button" class="btn btn-primary" data-id="${esc(o.id)}" data-status="${col.action.to}">${col.action.label}</button>
        ${col.back ? `<button type="button" class="btn btn-ghost" data-id="${esc(o.id)}" data-status="${col.back.to}">${col.back.label}</button>` : ''}
      </div>
    </article>`;
  }

  function paintOrders(orders, serverTime) {
    const board = document.getElementById('board');
    const doneWrap = document.getElementById('done-wrap');
    if (!board) return;

    const now = Date.now() + serverOffset;
    const wasOpen = !!(doneWrap.querySelector('details') || {}).open;

    const columns = COLUMNS.map((col) => {
      const list = orders.filter((o) => o.status === col.status);
      return `<section class="board-col col-${col.status}" aria-label="${col.title}">
        <h2>${col.title} <span class="count">${list.length}</span></h2>
        ${list.length ? list.map((o) => orderCard(o, col, now)).join('') : `<p class="col-empty">${col.empty}</p>`}
      </section>`;
    }).join('');

    const done = orders.filter((o) => o.status === 'completed');
    const doneHtml = done.length
      ? `<details class="done-list"${wasOpen ? ' open' : ''}>
          <summary>Recently picked up (${done.length})</summary>
          <ul>${done
            .map(
              (o) => `<li>
                <span><strong>${esc(o.code)}</strong> ${esc(o.customerName)}</span>
                <span>${peso(o.total)}</span>
                <button type="button" class="link-btn" data-id="${esc(o.id)}" data-status="ready">Move back to ready</button>
              </li>`
            )
            .join('')}</ul>
        </details>`
      : '';

    const html = columns + '\u0000' + doneHtml;
    if (html === lastOrdersHtml) return;
    lastOrdersHtml = html;
    board.innerHTML = columns;
    doneWrap.innerHTML = doneHtml;
  }

  async function refreshOrders() {
    try {
      const { orders, serverTime } = await staffApi('/api/staff/orders');
      serverOffset = new Date(serverTime).getTime() - Date.now();

      if (knownIds) {
        const fresh = orders.filter((o) => o.status === 'received' && !knownIds.has(o.id));
        if (fresh.length) {
          beep();
          toast(`New order ${fresh.map((o) => o.code).join(', ')}`, 'ok');
        }
      }
      knownIds = new Set(orders.map((o) => o.id));

      paintOrders(orders, serverTime);
      const updated = document.getElementById('updated');
      if (updated) updated.textContent = `Updated ${new Date().toLocaleTimeString('en-PH')}. Refreshes every few seconds.`;
    } catch (err) {
      if (err.status === 401) return logout('Your session ended. Sign in again.');
      const updated = document.getElementById('updated');
      if (updated) updated.textContent = err.message;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Menu availability                                                 */
  /* ---------------------------------------------------------------- */

  async function loadMenuPanel() {
    const panel = document.getElementById('menu-panel');
    try {
      const { items } = await staffApi('/api/menu');
      menuItems = items;
      panel.innerHTML = `<div class="staff-panel-head"><div><p class="eyebrow">BREAD MENU MANAGER</p><h2>Food catalog</h2><p class="sub">Add new food, edit every detail, remove old items, or mark a dish sold out.</p></div><button class="btn btn-primary" type="button" data-menu-action="new">Add food</button></div><form class="form-card menu-editor" id="food-form" enctype="multipart/form-data" hidden><input id="food-id" type="hidden" /><h3 id="food-form-title">Add food</h3><div class="editor-grid"><label class="field"><span>Name</span><input id="food-name" required /></label><label class="field"><span>Category</span><input id="food-category" required placeholder="Rice Meals" /></label><label class="field"><span>Price</span><input id="food-price" type="number" min="0" step="1" required /></label><label class="field"><span>Prep minutes</span><input id="food-prep" type="number" min="1" step="1" required /></label><label class="field editor-wide"><span>Food picture</span><input id="food-image" type="file" accept="image/png,image/jpeg,image/webp" /><small class="field-help">Upload a clear photo of this dish. A picture is required when adding a new food.</small></label><label class="field editor-wide"><span>Description</span><textarea id="food-description" rows="2" required></textarea></label></div><div class="editor-actions"><button class="btn btn-primary" type="submit">Save food</button><button class="btn btn-ghost" type="button" data-menu-action="cancel">Cancel</button></div></form><div class="menu-admin-list">${items.length ? items.map((m) => `<article class="menu-admin-row"><span class="food-thumb tint-${items.indexOf(m) % 5}" aria-hidden="true"><img src="${esc(m.imageUrl || '')}" alt="" onerror="this.hidden=true" /></span><div class="menu-admin-main"><strong>${esc(m.name)}</strong><span>${esc(m.category)} · ${peso(m.price)} · ${m.prepMinutes} min</span><small>${esc(m.description)}</small></div><div class="menu-admin-actions"><label class="availability-toggle"><span>${m.available ? 'Available' : 'Sold out'}</span><input type="checkbox" role="switch" data-avail="${esc(m.id)}" data-name="${esc(m.name)}"${m.available ? ' checked' : ''} /></label><button class="btn btn-ghost" type="button" data-menu-action="edit" data-id="${esc(m.id)}">Edit</button><button class="btn btn-danger" type="button" data-menu-action="delete" data-id="${esc(m.id)}">Delete</button></div></article>`).join('') : '<div class="empty"><h2>No food items</h2><p>Add the first dish to your canteen menu.</p></div>'}</div>`;
    } catch (err) {
      panel.innerHTML = `<div class="notice notice-out">${esc(err.message)}</div>`;
    }
  }

  function openFoodEditor(id) {
    const item = menuItems.find((entry) => entry.id === id);
    document.getElementById('food-form-title').textContent = item ? `Edit ${item.name}` : 'Add food';
    document.getElementById('food-id').value = item?.id || '';
    document.getElementById('food-name').value = item?.name || '';
    document.getElementById('food-category').value = item?.category || '';
    document.getElementById('food-price').value = item?.price || '';
    document.getElementById('food-prep').value = item?.prepMinutes || '';
    document.getElementById('food-description').value = item?.description || '';
    document.getElementById('food-form').hidden = false;
    document.getElementById('food-name').focus();
  }

  async function saveFood(event) {
    event.preventDefault();
    const id = document.getElementById('food-id').value;
    const item = menuItems.find((entry) => entry.id === id);
    const body = new FormData();
    body.append('name', document.getElementById('food-name').value.trim());
    body.append('category', document.getElementById('food-category').value.trim());
    body.append('price', document.getElementById('food-price').value);
    body.append('prepMinutes', document.getElementById('food-prep').value);
    body.append('description', document.getElementById('food-description').value.trim());
    const image = document.getElementById('food-image').files[0];
    if (image) body.append('foodImage', image);
    if (!id && !image) {
      toast('Please choose a picture for the new food.', 'warn');
      return;
    }
    try {
      await staffApi(id ? `/api/admin/menu/${encodeURIComponent(id)}` : '/api/admin/menu', { method: id ? 'PUT' : 'POST', body });
      toast(id ? 'Food details updated.' : 'Food added to the menu.', 'ok');
      await loadMenuPanel();
    } catch (error) { toast(error.message, 'bad'); }
  }

  async function deleteFood(id) {
    const item = menuItems.find((entry) => entry.id === id);
    if (!item || !window.confirm(`Delete ${item.name} from the menu?`)) return;
    try {
      await staffApi(`/api/admin/menu/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast(`${item.name} was deleted.`, 'ok');
      await loadMenuPanel();
    } catch (error) { toast(error.message, 'bad'); }
  }

  async function loadProfilePanel() {
    const panel = document.getElementById('profile-panel');
    try {
      const { user } = await staffApi('/api/staff/profile');
      panel.innerHTML = `<div class="page-head"><p class="eyebrow">STAFF ACCOUNT</p><h2>My profile</h2><p class="sub">Your profile is locked until you choose to edit it.</p></div><form class="form-card profile-form" id="profile-form"><label class="field"><span>Full name</span><input id="profile-name" type="text" value="${esc(user.name)}" disabled required /></label><label class="field"><span>Email</span><input id="profile-email" type="email" value="${esc(user.email)}" disabled required /></label><div class="account-role"><span>Role</span><strong>Staff / administrator</strong></div><div class="profile-actions"><button class="btn btn-primary btn-block" type="button" data-profile-action="edit">Edit profile</button><button class="btn btn-primary btn-block" type="submit" data-profile-action="save" hidden>Save profile</button><button class="btn btn-ghost btn-block" type="button" data-profile-action="cancel" hidden>Cancel</button></div></form>`;
    } catch (error) { panel.innerHTML = `<div class="notice notice-out">${esc(error.message)}</div>`; }
  }

  function setProfileEditing(editing) {
    const form = document.getElementById('profile-form');
    if (!form) return;
    form.querySelectorAll('input').forEach((input) => { input.disabled = !editing; });
    form.querySelector('[data-profile-action="edit"]').hidden = editing;
    form.querySelector('[data-profile-action="save"]').hidden = !editing;
    form.querySelector('[data-profile-action="cancel"]').hidden = !editing;
    if (editing) document.getElementById('profile-name').focus();
  }

  async function saveProfile(event) {
    event.preventDefault();
    try {
      await staffApi('/api/staff/profile', { method: 'PATCH', body: JSON.stringify({ name: document.getElementById('profile-name').value.trim(), email: document.getElementById('profile-email').value.trim() }) });
      toast('Staff profile saved.', 'ok');
      await loadProfilePanel();
    } catch (error) { toast(error.message, 'bad'); }
  }

  async function loadIdeasPanel() {
    const panel = document.getElementById('ideas-panel');
    try {
      const { suggestions } = await staffApi('/api/suggestions');
      panel.innerHTML = suggestions.length ? suggestions.map((suggestion) => `<article class="idea-card"><div><span class="eyebrow">${esc(suggestion.category)}</span><h2>${esc(suggestion.foodName)}</h2><p>${esc(suggestion.reason)}</p><small>From ${esc(suggestion.customerName)} · ${new Date(suggestion.createdAt).toLocaleDateString()}</small></div><select data-suggestion="${esc(suggestion.id)}"><option value="pending"${suggestion.status === 'pending' ? ' selected' : ''}>Pending</option><option value="approved"${suggestion.status === 'approved' ? ' selected' : ''}>Approve</option><option value="planned"${suggestion.status === 'planned' ? ' selected' : ''}>Planned</option><option value="declined"${suggestion.status === 'declined' ? ' selected' : ''}>Decline</option></select></article>`).join('') : '<div class="empty"><h2>No suggestions yet</h2><p>Student menu ideas will appear here.</p></div>';
    } catch (error) { panel.innerHTML = `<div class="notice notice-out">${esc(error.message)}</div>`; }
  }

  /* ---------------------------------------------------------------- */
  /* Events (attached once, work for every screen)                     */
  /* ---------------------------------------------------------------- */

  $root.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) return selectTab(tab.dataset.tab);

    const menuAction = e.target.closest('[data-menu-action]');
    if (menuAction) {
      if (menuAction.dataset.menuAction === 'new') return openFoodEditor();
      if (menuAction.dataset.menuAction === 'edit') return openFoodEditor(menuAction.dataset.id);
      if (menuAction.dataset.menuAction === 'delete') return deleteFood(menuAction.dataset.id);
      if (menuAction.dataset.menuAction === 'cancel') {
        document.getElementById('food-form').hidden = true;
        return;
      }
    }

    const profileAction = e.target.closest('[data-profile-action]');
    if (profileAction) {
      if (profileAction.dataset.profileAction === 'edit') return setProfileEditing(true);
      if (profileAction.dataset.profileAction === 'cancel') return loadProfilePanel();
    }

    const btn = e.target.closest('button[data-status]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await staffApi(`/api/staff/orders/${encodeURIComponent(btn.dataset.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: btn.dataset.status }),
      });
      await refreshOrders();
    } catch (err) {
      toast(err.message, 'bad');
      btn.disabled = false;
    }
  });

  $root.addEventListener('change', async (e) => {
    const suggestion = e.target.closest('select[data-suggestion]');
    if (suggestion) {
      try { await staffApi(`/api/suggestions/${encodeURIComponent(suggestion.dataset.suggestion)}`, { method: 'PATCH', body: JSON.stringify({ status: suggestion.value }) }); toast('Suggestion status updated.', 'ok'); } catch (error) { toast(error.message, 'bad'); }
      return;
    }
    const input = e.target.closest('input[data-avail]');
    if (!input) return;
    const available = input.checked;
    const label = input.closest('label').querySelector('span');
    try {
      await staffApi(`/api/staff/menu/${encodeURIComponent(input.dataset.avail)}`, {
        method: 'PATCH',
        body: JSON.stringify({ available }),
      });
      label.textContent = available ? 'Available' : 'Sold out';
      toast(`${input.dataset.name} is now ${available ? 'available' : 'sold out'}.`, available ? 'ok' : 'warn');
    } catch (err) {
      input.checked = !available; // put the switch back
      toast(err.message, 'bad');
    }
  });

  $root.addEventListener('submit', (e) => {
    if (e.target.id === 'food-form') saveFood(e);
    if (e.target.id === 'profile-form') saveProfile(e);
  });

  /* ---------------------------------------------------------------- */
  /* Start                                                             */
  /* ---------------------------------------------------------------- */

  (async function init() {
    if (staffToken) {
      try {
        await staffApi('/api/auth/staff/me');
        return showBoard();
      } catch (err) {
        staffToken = '';
        try { sessionStorage.removeItem('cfs_staff_token'); } catch (storageError) { /* ignore */ }
      }
    }
    pin = '';
    try { sessionStorage.removeItem('cfs_staff_pin'); } catch (storageError) { /* ignore */ }
    showLogin();
  })();
})();
