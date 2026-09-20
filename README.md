# Campus Pickup: Food Pre-Order and Pickup System

Students order food from their phones, do something else while the stall prepares it, and pick it up when it's ready.

- **Student app** (`/`): Menu → Food details → Cart → Order summary → Order tracking → Pickup, plus order history.
- **Staff board** (`/staff`): see new orders, move them to *Preparing → Ready → Picked up*, and mark items sold out.
- **Customer accounts**: register, sign in, recover access, order online, see estimated ready times, receive notifications, and suggest new food ideas.
- **Staff portal** (`/staff`): staff register with a private verification code, sign in separately, review orders and ideas, and manage menu/order data.
- **Role separation**: customer and staff sessions are separate; the staff portal does not expose customer navigation.
- Requires Node.js 18+ and the runtime packages listed in `package.json` (`express` and `multer`). Run `npm install` once before `npm start`.

## Run it locally (VS Code)

1. Install **Node.js 18 or newer** (https://nodejs.org).
2. Open this folder in VS Code (`File > Open Folder`).
3. Open the terminal (`Ctrl+` `` ` ``) and run:

   ```bash
   npm start
   ```

4. Open:
   - Student app: http://localhost:3000
   - Staff board: http://localhost:3000/staff (default PIN: `1234`)

Tip: `npm run dev` restarts the server automatically whenever you edit `server.js`.

### Try it on your phone
Connect your phone to the same Wi-Fi as your computer, find your computer's local IP (for example `192.168.1.20`) and open `http://192.168.1.20:3000` on the phone.

### Change the staff PIN
```bash
# macOS / Linux / Git Bash
STAFF_PIN=8642 npm start

# Windows PowerShell
$env:STAFF_PIN="8642"; npm start
```

Set the staff registration verification code before deployment:

```powershell
$env:STAFF_INVITE_CODE="your-private-staff-code"; npm start
```

The local development default verification code is `2006`. Change it before deployment.

### Account and admin notes

Customer accounts are stored in `data/users.json` with salted password hashes. The staff board is protected by `STAFF_PIN`. Admin menu routes follow BREAD operations: browse/read through the menu and board APIs, add with `POST /api/admin/menu`, edit with `PUT /api/admin/menu/:id`, and delete with `DELETE /api/admin/menu/:id`.

## Project structure

```
campus-food-system/
├── server.js              Node.js server: REST API + serves the web pages
├── package.json
├── data/
│   ├── menu.seed.json     Starting menu (edit this to change the food list)
│   ├── menu.json          Created on first run (live menu, availability)
│   └── orders.json        Created on first run (all orders)
└── public/
    ├── index.html         Student app shell
    ├── staff.html         Staff board shell
    ├── css/styles.css     All styling
    └── js/
        ├── common.js      Shared helpers (API calls, toast, beep, ETA formula)
        ├── app.js         Student app (menu, cart, checkout, tracking, history)
        └── staff.js       Staff board (login, orders, availability)
```

## Customize

| What | Where |
| --- | --- |
| Food items, prices, prep times, emoji | `data/menu.seed.json`. Delete `data/menu.json` afterwards so the seed is reloaded. |
| Pickup location text | `PICKUP_POINT` at the top of `public/js/app.js` |
| Colors and fonts | CSS variables at the top of `public/css/styles.css` |
| How the ready-time estimate is computed | `estimateMinutes` in `server.js` and `public/js/common.js` (keep both the same) |

**Estimate formula:** longest prep time in the order + 1 min for every 2 extra pieces + 1 min for each order already waiting (max 10).

## Deploy

The app needs a server that stays running (staff and students share live orders), so use a Node host such as **Render**, **Railway** or **Fly.io**. Static-only hosts (GitHub Pages, and Netlify/Vercel without extra setup) will not work as-is.

### Render (example)
1. Push this folder to a GitHub repository.
2. On https://render.com choose **New > Web Service** and connect the repo.
3. Settings:
   - Runtime: **Node**
   - Build command: `npm install` (or leave empty)
   - Start command: `npm start`
4. Under **Environment**, add `STAFF_PIN` with your own secret PIN.
5. Deploy. Render gives you an `https://…onrender.com` link. Students use `/`, staff use `/staff`.

### Environment variables
| Name | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Set automatically by most hosts |
| `STAFF_PIN` | `1234` | PIN for the staff board. **Change it before deploying.** |
| `DATA_DIR` | `./data` | Folder where `menu.json` and `orders.json` are saved |

### Important: saving data on a host
Orders and menu changes are saved as JSON files. Free hosting plans usually wipe the disk when the app redeploys or restarts, so orders would reset. For a demo this is fine. For real use, either:
- attach a persistent disk (Render/Railway/Fly volumes) and set `DATA_DIR` to its mount path, for example `DATA_DIR=/var/data`, or
- move storage to a database (for example PostgreSQL). Only the `readJson` / `writeJson` / `saveOrders` / `saveMenu` parts of `server.js` need to change.

## API summary

| Method | Path | Who | What |
| --- | --- | --- | --- |
| GET | `/api/menu` | Student | Menu with availability |
| GET | `/api/queue` | Student | Number of orders waiting (used for the estimate) |
| POST | `/api/orders` | Student | Place an order (`customerName`, `note`, `items:[{id, qty}]`) |
| GET | `/api/orders/:id` | Student | Order status |
| GET | `/api/orders?ids=a,b` | Student | Several orders (order history) |
| POST | `/api/staff/login` | Staff | Check the PIN |
| GET | `/api/staff/orders` | Staff | Active and recently completed orders |
| PATCH | `/api/staff/orders/:id` | Staff | Change status (`received`, `preparing`, `ready`, `completed`) |
| PATCH | `/api/staff/menu/:id` | Staff | Mark an item available or sold out |

Staff requests send the PIN in the `x-staff-pin` header. Prices and availability are always checked on the server, so the browser cannot change the total.

## How it matches the project scope (MoSCoW)

- **Must have:** menu, food details, availability, cart, order summary, place order, order tracking.
- **Should have:** order history, estimated preparation time, ready-for-pickup alert (on-screen message, sound, vibration, and a browser notification if allowed).
- **Could have (not built yet):** QR-code pickup.
- **Won't have (left out on purpose):** online payment, delivery outside campus, AI food chatbot, full inventory management.

## Known limits and next steps
- The "ready" alert works while the tracking page is open. Alerts when the app is closed would need push notifications (a service worker plus HTTPS).
- One shared staff PIN. For real use, add individual staff accounts.
- Add rate limiting if the site will be public, so nobody can flood it with fake orders.
