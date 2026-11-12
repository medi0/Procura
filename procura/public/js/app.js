/* Procura front end - one page app, role aware. All data comes from the Express API. */
const $ = s => document.querySelector(s), m = $('#m');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const lbl = s => { s = String(s ?? '').replace(/_/g, ' ').toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); };
const pill = s => { const u = String(s || '').toUpperCase(); const c = /PEND|PLACED|PROCESS|REFUND|LOW/.test(u) ? 'wn' : /FAIL|REJECT|CANCEL|INACTIVE/.test(u) ? 'rd' : ''; return `<span class="p ${c}">${esc(lbl(s))}</span>`; };
const d10 = s => s ? String(s).slice(0, 10) : '–';
const ref = o => o.invoice_number || 'ORD-' + o.order_id;
let me = null, tok = 0;

async function api(url, opt = {}) {
  const o = { method: opt.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opt.body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opt.body); }
  const r = await fetch(url, o);
  let d = null; try { d = await r.json(); } catch (_) {}
  if (r.status === 401) { location.href = '/login.html'; throw new Error('Signed out'); }
  if (!r.ok) { const e = new Error(d?.error || 'Request failed'); e.data = d; e.status = r.status; throw e; }
  return d;
}
function toast(x) { const t = $('#t'); t.textContent = x; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2600); }
const head = (t, s) => `<div class="hd"><div><h1>${esc(t)}</h1><p>${esc(s)}</p></div></div>`;
const foot = k => `<details><summary>SQL behind this page</summary><pre>${esc(SQL[k] || '')}</pre></details>`;
const table = (heads, rows, empty = 'Nothing here yet.') =>
  `<div class="w"><table><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr>${rows.length ? rows.join('') : `<tr><td colspan="${heads.length}" class="empty">${esc(empty)}</td></tr>`}</table></div>`;
const opts = (list, val, txt, sel) => list.map(x => `<option value="${esc(x[val])}" ${x[val] == sel ? 'selected' : ''}>${esc(typeof txt === 'function' ? txt(x) : x[txt])}</option>`).join('');

const NAV = {
  ADMIN: [['dashboard', 'Overview'], ['orders', 'Orders'], ['inventory', 'Inventory'], ['suppliers', 'Suppliers'], ['catalogue', 'Catalogue'], ['warehouses', 'Warehouses'], ['users', 'Users'], ['shipments', 'Shipments'], ['payments', 'Payments'], ['schema', 'Schema']],
  BUYER: [['dashboard', 'Overview'], ['find', 'Find suppliers'], ['orders', 'Orders'], ['shipments', 'Shipments']],
  SUPPLIER: [['dashboard', 'Overview'], ['offers', 'My offers'], ['inventory', 'Inventory'], ['orders', 'Orders']],
  WAREHOUSE_MANAGER: [['dashboard', 'Overview'], ['inventory', 'Stock'], ['shipments', 'Shipments']]
};

const SQL = {
  dashboard: `SELECT status, COUNT(*) AS orders FROM ORDERS GROUP BY status;\n\nSELECT p.product_name, i.available_quantity\nFROM INVENTORY i JOIN SUPPLIER_PRODUCT sp USING(supplier_product_id)\nJOIN PRODUCT p USING(product_id)\nWHERE i.available_quantity <= i.reorder_level;   -- available_quantity is a generated column`,
  orders: `SELECT o.order_id, b.company_name, o.status, t.total_amount\nFROM ORDERS o JOIN BUYER b ON b.user_id = o.buyer_id\nLEFT JOIN v_order_totals t USING(order_id);\n\n-- buyers query a view instead, filtered to their own id:\nSELECT * FROM v_buyer_orders WHERE buyer_id = ?;`,
  inventory: `-- stock is received with an upsert; a CHECK constraint keeps reserved <= on hand\nINSERT INTO INVENTORY(supplier_product_id, warehouse_id, quantity_on_hand, reorder_level)\nVALUES (?,?,?,?)\nON DUPLICATE KEY UPDATE quantity_on_hand = quantity_on_hand + VALUES(quantity_on_hand);\n\nSELECT * FROM v_warehouse_stock WHERE manager_id = ?;`,
  suppliers: `SELECT s.business_name, s.verification_status, s.reliability_score, COUNT(sp.supplier_product_id) AS listings\nFROM SUPPLIER s LEFT JOIN SUPPLIER_PRODUCT sp ON sp.supplier_id = s.user_id\nGROUP BY s.user_id ORDER BY s.verification_status;\n\nUPDATE SUPPLIER SET verification_status = 'VERIFIED' WHERE user_id = ?;`,
  shipments: `SELECT sh.tracking_number, w.warehouse_name, sh.shipment_status, sh.expected_delivery_date\nFROM SHIPMENT sh JOIN WAREHOUSE w USING(warehouse_id) JOIN ORDERS o USING(order_id);\n\n-- dispatch moves stock out inside one transaction:\nUPDATE INVENTORY i JOIN ORDER_ITEM oi ON oi.inventory_id = i.inventory_id\nSET i.quantity_on_hand = i.quantity_on_hand - oi.quantity,\n    i.reserved_quantity = i.reserved_quantity - oi.quantity\nWHERE oi.order_id = ? AND i.warehouse_id = ?;`,
  find: `-- the ordering transaction (per order)\nSTART TRANSACTION;\nSELECT inventory_id, quantity_on_hand, reserved_quantity FROM INVENTORY\nWHERE inventory_id IN (...) ORDER BY inventory_id FOR UPDATE;   -- row locks, ascending order\nINSERT INTO ORDERS ...;  INSERT INTO ORDER_ITEM ... (unit_price copied = price lock);\nUPDATE INVENTORY SET reserved_quantity = reserved_quantity + ? WHERE inventory_id = ?;\nINSERT INTO SHIPMENT ... (one per warehouse);  INSERT INTO PAYMENT ... 'PENDING';\nCOMMIT;   -- any error: ROLLBACK\n\n-- ranking: min-max normalise each factor with window functions, then weight\n(MAX(unit_price) OVER () - unit_price) / NULLIF(MAX(unit_price) OVER () - MIN(unit_price) OVER (), 0) AS price_n`,
  offers: `INSERT INTO SUPPLIER_PRODUCT(supplier_id, product_id, unit_price, min_order_qty, lead_time_days)\nVALUES (?,?,?,?,?);\n\nUPDATE SUPPLIER_PRODUCT SET unit_price = ? WHERE supplier_product_id = ? AND supplier_id = ?;\n-- existing ORDER_ITEM rows keep their own unit_price`,
  catalogue: `INSERT INTO CATEGORY(category_name, description) VALUES (?,?);\nINSERT INTO PRODUCT(category_id, product_name, unit) VALUES (?,?,?);`,
  warehouses: `UPDATE WAREHOUSE SET manager_id = ? WHERE warehouse_id = ?;\n-- trigger trg_warehouse_mgr_upd rejects users whose role is not WAREHOUSE_MANAGER`,
  users: `INSERT INTO USERS(full_name, email, password_hash, role) VALUES (?,?,?,?);   -- bcrypt hash\nINSERT INTO BUYER(user_id, ...) VALUES (...);   -- trigger checks the role matches`,
  payments: `SELECT pay.payment_id, b.company_name, pay.amount, pay.payment_status, pay.transaction_ref\nFROM PAYMENT pay JOIN ORDERS o USING(order_id) JOIN BUYER b ON b.user_id = o.buyer_id;`
};

/* ------------------------------------------------------------------ pages */
const V = {
  async dashboard() {
    const d = await api('/api/dashboard');
    const n = d.chart.values.length, mx = Math.max(1, ...d.chart.values), step = 420 / n, bw = Math.min(56, step - 14);
    const bars = d.chart.values.map((c, i) => {
      const h = c / mx * 110, x = i * step + (step - bw) / 2, cx = x + bw / 2, hl = /deliver/i.test(d.chart.labels[i]);
      return `<rect x="${x}" y="${140 - h}" width="${bw}" height="${h}" rx="6" fill="${hl ? '#0f766e' : '#e8a200'}"/><text x="${cx}" y="${132 - h}" text-anchor="middle" fill="currentColor" font-size="14" font-weight="700">${c}</text><text x="${cx}" y="160" text-anchor="middle" fill="currentColor" font-size="11" opacity=".7">${esc(d.chart.labels[i])}</text>`;
    }).join('');
    return head(d.title, d.subtitle) +
      `<div class="g k">${d.kpis.map(k => `<div class="c"><b>${esc(k.value)}</b><span>${esc(k.label)}</span></div>`).join('')}</div>
      <div class="g two mt"><div class="c"><h3>${esc(d.chart.title)}</h3><svg viewBox="0 0 420 170" width="100%" role="img" aria-label="${esc(d.chart.title)}">${bars}</svg></div>
      <div class="c"><h3>${esc(d.side.title)}</h3>${d.side.items.map(i => `<p style="margin:10px 0 0"><b>${esc(i.t)}</b><br><small class="mu">${esc(i.s)}</small></p>`).join('') || `<p class="mu">${esc(d.side.empty)}</p>`}</div></div>` + foot('dashboard');
  },

  /* ---------- orders ---------- */
  async orders() {
    const rows = await api('/api/orders');
    if (me.role === 'SUPPLIER') {
      return head('Orders', 'Order lines for your offers') + `<div class="c">` + table(['Order', 'Date', 'Status', 'Product', 'Qty', 'Unit price', 'Line total', 'Buyer'],
        rows.map(o => `<tr><td>ORD-${o.order_id}</td><td>${d10(o.order_date)}</td><td>${pill(o.status)}</td><td>${esc(o.product_name)}</td><td>${o.quantity} ${esc(o.unit)}</td><td>${inr(o.unit_price)}</td><td>${inr(o.line_total)}</td><td>${esc(o.buyer_company)} · ${esc(o.buyer_city)}</td></tr>`), 'No orders for your offers yet.') + `</div>` + foot('orders');
    }
    const adm = me.role === 'ADMIN';
    return head('Orders', 'Select an order to see its line items, shipments and payments') + `<div class="c">` +
      table(['Order / invoice', ...(adm ? ['Buyer'] : []), 'Date', 'Status', 'Total', 'Payment'],
        rows.map(o => `<tr class="x" data-a="open" data-id="${o.order_id}"><td>${esc(ref(o))}</td>${adm ? `<td>${esc(o.buyer)}</td>` : ''}<td>${d10(o.order_date)}</td><td>${pill(o.status)}</td><td>${inr(o.total_amount)}</td><td>${pill(o.payment_status || 'PENDING')}</td></tr>`),
        me.role === 'BUYER' ? 'No orders yet. Use Find suppliers to place one.' : 'No orders yet.') + `</div><div id="d"></div>` + foot('orders');
  },

  /* ---------- inventory ---------- */
  async inventory() {
    const wm = me.role === 'WAREHOUSE_MANAGER', adm = me.role === 'ADMIN';
    const [rows, whs, offs] = await Promise.all([api('/api/inventory'), wm ? api('/api/wm/warehouses') : [], wm ? api('/api/wm/offers') : []]);
    window.INV = rows;
    const form = wm ? `<form class="c fm cols mt" data-f="receive"><h3 style="grid-column:1/-1">Receive stock</h3>
      <label>Warehouse<select name="warehouse_id" required>${opts(whs, 'warehouse_id', x => `${x.warehouse_name} (${x.city})`)}</select></label>
      <label>Product from supplier<select name="supplier_product_id" required>${opts(offs, 'supplier_product_id', x => `${x.product_name} · ${x.supplier_name}`)}</select></label>
      <label>Quantity received<input name="quantity" type="number" min="1" required></label>
      <label>Reorder level (optional)<input name="reorder_level" type="number" min="0"></label><button>Record receipt</button></form>` : '';
    return head(wm ? 'Stock' : 'Inventory', 'Available quantity = on hand − reserved (derived column)') +
      `<div class="c"><input id="f" placeholder="Search product, supplier or warehouse" style="margin-bottom:10px;width:min(340px,100%)"><div id="tb"></div></div>` + form + foot('inventory');
  },

  /* ---------- suppliers (admin) ---------- */
  async suppliers() {
    const [sup, offs] = await Promise.all([api('/api/admin/suppliers'), api('/api/admin/offers')]);
    return head('Suppliers', 'Verify new suppliers and set reliability scores') +
      `<div class="g k">${sup.map(s => `<div class="c"><div class="sup"><div class="ring" style="--v:${Number(s.reliability_score)}"><span>${Math.round(s.reliability_score)}</span></div>
        <div><h3>${esc(s.business_name)}</h3><small>${esc(s.city)} · ${s.listings} listings</small><br>${pill(s.verification_status)}</div></div>
        <div class="row mt" data-sid="${s.user_id}">${s.verification_status !== 'VERIFIED' ? '<button class="sm" data-a="sup" data-st="VERIFIED">Verify</button>' : ''}${s.verification_status !== 'REJECTED' ? '<button class="sm dg" data-a="sup" data-st="REJECTED">Reject</button>' : ''}
        <input type="number" min="0" max="100" value="${Number(s.reliability_score)}" style="width:76px" aria-label="Reliability score" class="rs"><button class="sm s" data-a="score">Save score</button></div></div>`).join('')}</div>
      <div class="c mt"><h3>Supplier price list</h3>` + table(['Product', 'Supplier', 'Unit price', 'Lead time', 'Min order', 'Active'],
        offs.map(x => `<tr><td>${esc(x.product_name)}</td><td>${esc(x.supplier_name)}</td><td>${inr(x.unit_price)}/${esc(x.unit)}</td><td>${x.lead_time_days} days</td><td>${x.min_order_qty}</td><td>${x.is_active ? 'Yes' : 'No'}</td></tr>`)) + `</div>` + foot('suppliers');
  },

  /* ---------- catalogue (admin) ---------- */
  async catalogue() {
    const [cats, prods] = await Promise.all([api('/api/categories'), api('/api/products')]);
    return head('Catalogue', 'Categories and products that suppliers can offer') +
      `<div class="g two"><form class="c fm" data-f="cat"><h3>New category</h3><label>Name<input name="category_name" required maxlength="80"></label><label>Description<input name="description" maxlength="255"></label><button>Add category</button></form>
      <form class="c fm" data-f="prod"><h3>New product</h3><label>Category<select name="category_id" required>${opts(cats, 'category_id', 'category_name')}</select></label><label>Name<input name="product_name" required maxlength="120"></label>
      <label>Unit of measure<input name="unit" required maxlength="20" placeholder="tonne, bag, piece…"></label><label>Description<input name="description" maxlength="255"></label><button>Add product</button></form></div>
      <div class="c mt"><h3>Products</h3>` + table(['Product', 'Category', 'Unit'], prods.map(p => `<tr><td>${esc(p.product_name)}</td><td>${esc(p.category_name)}</td><td>${esc(p.unit)}</td></tr>`)) + `</div>` + foot('catalogue');
  },

  /* ---------- warehouses (admin) ---------- */
  async warehouses() {
    const [whs, mgrs] = await Promise.all([api('/api/admin/warehouses'), api('/api/admin/users?role=WAREHOUSE_MANAGER')]);
    const sel = id => `<select class="mg"><option value="">Unassigned</option>${opts(mgrs, 'user_id', 'full_name', id)}</select>`;
    return head('Warehouses', 'Create warehouses and assign a manager to each') +
      `<form class="c fm cols" data-f="wh"><label>Name<input name="warehouse_name" required maxlength="80"></label><label>City<input name="city" required maxlength="60"></label>
      <label>Address<input name="address" maxlength="255"></label><label>Manager<select name="manager_id"><option value="">Unassigned</option>${opts(mgrs, 'user_id', 'full_name')}</select></label><button>Create warehouse</button></form>
      <div class="c mt">` + table(['Warehouse', 'City', 'Manager', ''], whs.map(w => `<tr data-wid="${w.warehouse_id}"><td>${esc(w.warehouse_name)}</td><td>${esc(w.city)}</td><td>${sel(w.manager_id)}</td><td><button class="sm s" data-a="assign">Save</button></td></tr>`)) + `</div>` + foot('warehouses');
  },

  /* ---------- users (admin) ---------- */
  async users() {
    const us = await api('/api/admin/users');
    return head('Users', 'Every account, with its role and status') +
      `<div class="c">` + table(['Name', 'Email', 'Role', 'Phone', 'Status', ''], us.map(u => `<tr><td>${esc(u.full_name)}</td><td>${esc(u.email)}</td><td>${esc(lbl(u.role))}</td><td>${esc(u.phones || '–')}</td><td>${pill(u.is_active ? 'Active' : 'Inactive')}</td>
        <td>${u.user_id === me.user_id ? '' : `<button class="sm s" data-a="active" data-id="${u.user_id}" data-on="${u.is_active ? 0 : 1}">${u.is_active ? 'Deactivate' : 'Activate'}</button>`}</td></tr>`)) + `</div>
      <form class="c fm cols mt" data-f="user" id="nu"><h3 style="grid-column:1/-1">Add a user</h3>
      <label>Role<select name="role" id="nrole">${['ADMIN', 'BUYER', 'SUPPLIER', 'WAREHOUSE_MANAGER'].map(r => `<option value="${r}">${lbl(r)}</option>`).join('')}</select></label>
      <label>Full name<input name="full_name" required maxlength="100"></label><label>Email<input name="email" type="email" required></label>
      <label>Password (8+ characters)<input name="password" type="password" minlength="8" required autocomplete="new-password"></label><label>Phone<input name="phone" maxlength="20"></label>
      <label><span id="xl">Designation</span><input name="extra" required maxlength="120"></label>
      <label class="geo" hidden>Address<input name="address" maxlength="255"></label><label class="geo" hidden>City<select name="city">${Object.keys(CITY).map(c => `<option>${c}</option>`).join('')}</select></label><button>Create user</button></form>` + foot('users');
  },

  async payments() {
    const p = await api('/api/admin/payments');
    return head('Payments', 'Every attempt is stored, so failed and repeated payments can be investigated') + `<div class="c">` +
      table(['Reference', 'Order', 'Buyer', 'Method', 'Amount', 'Status', 'Date'], p.map(x => `<tr><td>${esc(x.transaction_ref)}</td><td>ORD-${x.order_id}</td><td>${esc(x.buyer)}</td><td>${esc(lbl(x.payment_method))}</td><td>${inr(x.amount)}</td><td>${pill(x.payment_status)}</td><td>${esc(String(x.payment_date).slice(0, 16))}</td></tr>`)) + `</div>` + foot('payments');
  },

  /* ---------- shipments ---------- */
  async shipments() {
    const rows = await api('/api/shipments');
    const track = me.role !== 'WAREHOUSE_MANAGER' ? `<form class="c row" data-f="track" style="margin-bottom:12px"><input name="no" placeholder="Track by tracking number, e.g. PRC-00001-W1" style="flex:1;min-width:220px" required><button>Track</button></form><div id="tr"></div>` : '';
    return head('Shipments', 'Dispatch and delivery tracking') + track + (rows.map(shipCard).join('') || '<div class="c empty">No shipments yet.</div>') + foot('shipments');
  },

  /* ---------- buyer: find suppliers ---------- */
  async find() {
    const [prods, cat] = await Promise.all([api('/api/products'), api('/api/catalog')]);
    window.CAT = cat; CART = CART || [];
    return head('Find suppliers', 'Rank verified suppliers that have enough stock, then order from one or several') +
      `<div class="g two"><div><form class="c fm" data-f="rank"><div class="fm cols"><label>Product<select name="product_id" required>${opts(prods, 'product_id', p => `${p.product_name} (${p.unit})`)}</select></label>
      <label>Quantity<input name="quantity" type="number" min="1" value="10" required></label></div>
      <div class="wts">${[['w_price', 'Price', 30], ['w_avail', 'Availability', 15], ['w_dist', 'Distance', 15], ['w_lead', 'Lead time', 15], ['w_rel', 'Reliability', 25]].map(([n, l, v]) => `<label>${l} <output>${v}</output><input type="range" name="${n}" min="0" max="100" value="${v}"></label>`).join('')}</div>
      <div><button>Rank suppliers</button></div></form><div class="c mt" id="rk"><span class="mu">Pick a product and quantity, then rank suppliers.</span></div></div>
      <div class="c" id="cart"></div></div>
      <div class="c mt"><h3>Catalogue</h3><input id="cf" placeholder="Search products or suppliers" style="margin:8px 0;width:min(340px,100%)"><div id="ct"></div></div>` + foot('find');
  },

  /* ---------- supplier: offers ---------- */
  async offers() {
    const [offs, prods, p] = await Promise.all([api('/api/supplier/offers'), api('/api/products'), api('/api/auth/me')]);
    me = { ...me, ...p };
    const bn = p.verification_status === 'VERIFIED' ? '' : p.verification_status === 'REJECTED'
      ? '<div class="banner rd">Your supplier account was rejected, so buyers cannot see your offers. Contact an administrator.</div>'
      : '<div class="banner">Your account is waiting for verification. Buyers will see your offers once an administrator verifies you.</div>';
    const free = prods.filter(x => !offs.some(o => o.product_id === x.product_id));
    return head('My offers', 'Your price, minimum order and lead time for each product') + bn +
      `<div class="c">` + table(['Product', 'Unit price', 'Min order', 'Lead (days)', 'Active', ''], offs.map(o => `<tr data-oid="${o.supplier_product_id}"><td>${esc(o.product_name)} <small class="mu">per ${esc(o.unit)}</small></td>
        <td><input class="op" type="number" min="0.01" step="0.01" value="${o.unit_price}" style="width:110px"></td><td><input class="om" type="number" min="1" value="${o.min_order_qty}" style="width:80px"></td>
        <td><input class="ol" type="number" min="0" value="${o.lead_time_days}" style="width:70px"></td><td><input class="oa" type="checkbox" ${o.is_active ? 'checked' : ''} aria-label="Active"></td><td><button class="sm" data-a="saveoffer">Save</button></td></tr>`), 'You have not listed any products yet.') + `</div>
      <form class="c fm cols mt" data-f="offer"><h3 style="grid-column:1/-1">Publish a new offer</h3><label>Product<select name="product_id" required>${opts(free, 'product_id', x => `${x.product_name} (${x.unit})`)}</select></label>
      <label>Unit price (₹)<input name="unit_price" type="number" min="0.01" step="0.01" required></label><label>Minimum order<input name="min_order_qty" type="number" min="1" value="1" required></label>
      <label>Lead time (days)<input name="lead_time_days" type="number" min="0" value="3" required></label><button ${free.length ? '' : 'disabled'}>Publish offer</button></form>` + foot('offers');
  },

  schema() {
    const E = { USERS: 'user_id, full_name, email (unique), password_hash, role', USER_PHONE: 'phone (multivalued)', SUPPLIER: 'business_name, city, lat/long, verification_status, reliability_score', BUYER: 'company_name, city, lat/long', ADMIN: 'ISA of USERS · designation', WAREHOUSE_MANAGER: 'ISA of USERS · employee_code', CATEGORY: 'category_id, category_name', PRODUCT: 'product_id, name, unit', SUPPLIER_PRODUCT: 'unit_price, min_order_qty, lead_time_days', INVENTORY: 'on_hand, reserved, reorder_level, available~', WAREHOUSE: 'warehouse_id, city, manager_id', ORDERS: 'status, invoice_number, total~', ORDER_ITEM: 'weak entity · unit_price, line_total~', SHIPMENT: 'tracking_number, status, dates', PAYMENT: 'transaction_ref, status' };
    return head('Schema map', 'From the EER diagram: 14 entity sets and 15 tables (phone gets its own table)') +
      `<div class="er">${Object.entries(E).map(([k, v]) => `<div class="c"><h3>${k}</h3><ul>${v.split(', ').map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')}</div><p class="mu">~ derived attribute (generated column or view)</p>
      <pre>CREATE TRIGGER trg_buyer_role BEFORE INSERT ON BUYER FOR EACH ROW\nBEGIN\n  IF (SELECT role FROM USERS WHERE user_id = NEW.user_id) &lt;&gt; 'BUYER' THEN\n    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'User does not have the BUYER role';\n  END IF;\nEND;\n\nline_total DECIMAL(14,2) GENERATED ALWAYS AS (quantity * unit_price) STORED\navailable_quantity INT GENERATED ALWAYS AS (quantity_on_hand - reserved_quantity) STORED</pre>`;
  }
};

const CITY = ['Ahmedabad', 'Bengaluru', 'Chennai', 'Delhi', 'Hyderabad', 'Jaipur', 'Kolkata', 'Mumbai', 'Pune', 'Surat'];
const GEO = { Ahmedabad: [23.0225, 72.5714], Bengaluru: [12.9716, 77.5946], Chennai: [13.0827, 80.2707], Delhi: [28.6139, 77.2090], Hyderabad: [17.3850, 78.4867], Jaipur: [26.9124, 75.7873], Kolkata: [22.5726, 88.3639], Mumbai: [19.0760, 72.8777], Pune: [18.5204, 73.8567], Surat: [21.1702, 72.8311] };

/* ------------------------------------------------------------------ shared renderers */
function stage(s) { return s.shipment_status === 'DELIVERED' ? 3 : s.shipment_status === 'DISPATCHED' ? 2 : (s.order_status === 'PLACED' ? 0 : 1); }
function shipCard(s) {
  const n = stage(s), canAct = me.role === 'WAREHOUSE_MANAGER' || me.role === 'ADMIN';
  const act = canAct && s.shipment_status === 'PENDING' ? (s.order_status === 'PLACED' ? '<small class="mu">Waiting for payment</small>' : `<button class="sm" data-a="ship" data-do="dispatch" data-id="${s.shipment_id}">Mark dispatched</button>`)
    : canAct && s.shipment_status === 'DISPATCHED' ? `<button class="sm" data-a="ship" data-do="deliver" data-id="${s.shipment_id}">Mark delivered</button>` : '';
  return `<div class="c" style="margin-bottom:12px"><div class="row"><b>${esc(s.tracking_number)}</b> · ORD-${s.order_id}${s.buyer ? ' · ' + esc(s.buyer) : ''} · from ${esc(s.warehouse_name || s.warehouse_city)}${s.units ? ` · ${s.units} units` : ''} ${s.shipment_status === 'CANCELLED' ? pill('CANCELLED') : ''}<span style="margin-left:auto">${act}</span></div>
    ${s.shipment_status === 'CANCELLED' ? '' : `<div class="tl">${['Order placed', 'Paid & confirmed', 'Dispatched', 'Delivered'].map((l, i) => `<div class="${i <= n ? 'd' : ''}">${l}</div>`).join('')}</div>`}
    <small class="mu">Dispatched ${d10(s.dispatch_date)} · Expected ${d10(s.expected_delivery_date)} · Delivered ${d10(s.delivered_date)}</small></div>`;
}
function invRows() {
  const f = ($('#f')?.value || '').toLowerCase(), rows = (window.INV || []).filter(i => [i.product_name, i.supplier_name, i.warehouse_name].join(' ').toLowerCase().includes(f));
  const hasSup = (window.INV || []).some(i => i.supplier_name);
  $('#tb').innerHTML = table(['Product', ...(hasSup ? ['Supplier'] : []), 'Warehouse', 'On hand', 'Reserved', 'Available', 'Stock', 'Reorder at'], rows.map(i => {
    const low = i.available_quantity <= i.reorder_level;
    return `<tr><td>${esc(i.product_name)}</td>${hasSup ? `<td>${esc(i.supplier_name)}</td>` : ''}<td>${esc(i.warehouse_name)} <small class="mu">${esc(i.warehouse_city)}</small></td><td>${i.quantity_on_hand}</td><td>${i.reserved_quantity}</td>
      <td>${i.available_quantity} ${low ? pill('Low') : ''}</td><td><div class="bar ${low ? 'lo' : ''}"><i style="width:${Math.min(100, i.available_quantity / Math.max(1, i.quantity_on_hand) * 100)}%"></i></div></td><td>${i.reorder_level}</td></tr>`;
  }), 'No stock records match.');
}
function catRows() {
  const f = ($('#cf')?.value || '').toLowerCase();
  $('#ct').innerHTML = table(['Product', 'Category', 'Supplier', 'Price', 'Lead time', 'Min order', 'Available'], (window.CAT || []).filter(c => [c.product_name, c.supplier_name, c.category_name].join(' ').toLowerCase().includes(f)).map(c =>
    `<tr><td>${esc(c.product_name)}</td><td>${esc(c.category_name)}</td><td>${esc(c.supplier_name)} <small class="mu">${esc(c.supplier_city)}</small></td><td>${inr(c.unit_price)}/${esc(c.unit)}</td><td>${c.lead_time_days} days</td><td>${c.min_order_qty}</td><td>${c.total_available}</td></tr>`), 'No offers from verified suppliers match.');
}

/* ---- buyer cart ---- */
let CART = [], RANK = [], RCTX = null, SHORT = [];
function drawRank() {
  const el = $('#rk'); if (!el) return;
  el.innerHTML = RANK.length ? `<h3>Ranked suppliers for ${esc(RCTX.name)} × ${RCTX.qty}</h3>` + table(['#', 'Supplier', 'Price', 'Lead', 'Available', 'Distance', 'Match', ''], RANK.map((r, i) =>
    `<tr><td>${r.rank}</td><td>${esc(r.business_name)} <small class="mu">${esc(r.city)}</small></td><td>${inr(r.unit_price)}/${esc(RCTX.unit)}</td><td>${r.lead_time_days} d</td><td>${r.available}</td><td>${r.distance_km} km</td><td class="sc">${r.score}</td><td><button class="sm" data-a="add" data-i="${i}">Add to order</button></td></tr>`))
    : `<div class="empty">No verified supplier has ${RCTX ? RCTX.qty : 'enough'} in stock with a minimum order that fits. Try a smaller quantity.</div>`;
}
function drawCart() {
  const el = $('#cart'); if (!el) return;
  if (!CART.length) { el.innerHTML = '<h3>Your order</h3><p class="mu">Nothing added yet. Rank suppliers and add an offer.</p><div id="fb"></div>'; return; }
  const total = CART.reduce((a, l) => a + l.qty * l.price, 0);
  el.innerHTML = `<h3>Your order</h3><div id="fb"></div>` + table(['Item', 'Qty', 'Line', ''], CART.map((l, i) =>
    `<tr><td>${esc(l.product_name)}<br><small class="mu">${esc(l.supplier_name)} · ${inr(l.price)}/${esc(l.unit)}</small></td><td><input class="cq" data-i="${i}" type="number" min="${l.moq}" value="${l.qty}" style="width:84px"></td><td>${inr(l.qty * l.price)}</td><td><button class="sm s" data-a="rm" data-i="${i}" aria-label="Remove">✕</button></td></tr>`)) +
    `<p><b>Total ${inr(total)}</b><br><small class="mu">Prices are locked when you place the order.</small></p>
    <div class="fm"><label>Shipping address<input id="ship" value="${esc(me.address || '')}" maxlength="255"></label>
    <label>Payment method<select id="pm"><option value="UPI">UPI</option><option value="CARD">Card</option><option value="NETBANKING">Net banking</option><option value="BANK_TRANSFER">Bank transfer</option></select></label>
    <button data-a="place">Place order</button></div>`;
}

/* ---- order detail ---- */
async function openOrder(id) {
  const { order: o, items, shipments, payments } = await api('/api/orders/' + id);
  const buyer = me.role === 'BUYER', canCancel = ['PLACED', 'CONFIRMED'].includes(o.status);
  const payUI = buyer && o.status === 'PLACED' ? `<div class="row mt"><select id="pm"><option value="UPI">UPI</option><option value="CARD">Card</option><option value="NETBANKING">Net banking</option><option value="BANK_TRANSFER">Bank transfer</option></select>
      <button data-a="pay" data-id="${id}" data-sim="ok">Pay ${inr(o.total_amount)}</button><button class="s" data-a="pay" data-id="${id}" data-sim="fail">Simulate a failed payment</button></div>` : '';
  $('#d').innerHTML = `<div class="c mt"><div class="row"><h3>${esc(ref(o))} · line items</h3>${pill(o.status)}<span class="mu">${esc(o.shipping_address || '')}</span></div>
    ${table(['Product', 'Supplier', 'Ships from', 'Qty', 'Unit price (locked)', 'Line total'], items.map(i => `<tr><td>${esc(i.product_name)}</td><td>${esc(i.supplier_name)}</td><td>${esc(i.warehouse_city)}</td><td>${i.quantity} ${esc(i.unit)}</td><td>${inr(i.unit_price)}</td><td>${inr(i.line_total)}</td></tr>`))}
    <p><b>Total ${inr(o.total_amount)}</b></p>
    <h3 class="mt">Shipments</h3>${table(['Tracking number', 'From', 'Status', 'Expected'], shipments.map(s => `<tr><td>${esc(s.tracking_number)}</td><td>${esc(s.warehouse_city)}</td><td>${pill(s.shipment_status)}</td><td>${d10(s.expected_delivery_date)}</td></tr>`))}
    <h3 class="mt">Payment attempts</h3>${table(['Reference', 'Method', 'Status', 'Amount', 'Time'], payments.map(p => `<tr><td>${esc(p.transaction_ref)}</td><td>${esc(lbl(p.payment_method))}</td><td>${pill(p.payment_status)}</td><td>${inr(p.amount)}</td><td>${esc(String(p.payment_date).slice(0, 16))}</td></tr>`))}
    ${payUI}${canCancel ? `<div class="row mt"><button class="dg" data-a="cancel" data-id="${id}">Cancel order${o.status === 'CONFIRMED' ? ' and refund' : ''}</button></div>` : ''}</div>`;
  $('#d').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ------------------------------------------------------------------ actions (clicks) */
async function run(btn, fn) {
  if (btn) btn.disabled = true;
  try { await fn(); } catch (e) { if (e.message !== 'Signed out') toast(e.message); } finally { if (btn && btn.isConnected) btn.disabled = false; }
}
const reload = async keepOrder => { await go(); if (keepOrder) await openOrder(keepOrder); };
const A = {
  open: el => openOrder(el.dataset.id),
  pay: el => run(el, async () => {
    const r = await api(`/api/orders/${el.dataset.id}/pay`, { method: 'POST', body: { method: $('#pm').value, simulate: el.dataset.sim === 'fail' ? 'fail' : 'ok' } });
    toast(r.status === 'COMPLETED' ? `Payment complete · invoice ${r.invoice_number}` : 'Payment failed. The attempt was recorded; you can retry.');
    await reload(+el.dataset.id);
  }),
  cancel: el => confirm('Cancel this order? Reserved stock is released and any payment is refunded.') && run(el, async () => {
    await api(`/api/orders/${el.dataset.id}/cancel`, { method: 'POST' }); toast('Order cancelled · stock released'); await reload(+el.dataset.id);
  }),
  ship: el => run(el, async () => { await api(`/api/shipments/${el.dataset.id}/${el.dataset.do}`, { method: 'POST' }); toast(el.dataset.do === 'dispatch' ? 'Shipment dispatched · stock updated' : 'Shipment delivered'); await go(); }),
  sup: el => run(el, async () => { await api(`/api/admin/suppliers/${el.closest('[data-sid]').dataset.sid}/verification`, { method: 'POST', body: { status: el.dataset.st } }); toast('Supplier ' + lbl(el.dataset.st).toLowerCase()); await go(); }),
  score: el => run(el, async () => { const b = el.closest('[data-sid]'); await api(`/api/admin/suppliers/${b.dataset.sid}/verification`, { method: 'POST', body: { reliability_score: b.querySelector('.rs').value } }); toast('Reliability score saved'); await go(); }),
  assign: el => run(el, async () => { const r = el.closest('tr'); await api(`/api/admin/warehouses/${r.dataset.wid}/manager`, { method: 'PATCH', body: { manager_id: r.querySelector('.mg').value || null } }); toast('Manager updated'); await go(); }),
  active: el => run(el, async () => { await api(`/api/admin/users/${el.dataset.id}/active`, { method: 'PATCH', body: { is_active: el.dataset.on === '1' } }); await go(); }),
  saveoffer: el => run(el, async () => { const r = el.closest('tr'); await api('/api/supplier/offers/' + r.dataset.oid, { method: 'PATCH', body: { unit_price: r.querySelector('.op').value, min_order_qty: r.querySelector('.om').value, lead_time_days: r.querySelector('.ol').value, is_active: r.querySelector('.oa').checked } }); toast('Offer saved · existing orders keep their locked price'); }),
  add: el => {
    const r = RANK[+el.dataset.i], ex = CART.find(l => l.supplier_product_id === r.supplier_product_id);
    if (ex) ex.qty += RCTX.qty; else CART.push({ supplier_product_id: r.supplier_product_id, product_name: RCTX.name, unit: RCTX.unit, supplier_name: r.business_name, price: r.unit_price, qty: RCTX.qty, moq: r.min_order_qty });
    drawCart(); toast('Added to your order');
  },
  rm: el => { CART.splice(+el.dataset.i, 1); drawCart(); },
  swap: el => {
    const s = SHORT.find(x => x.supplier_product_id === +el.dataset.sp), l = CART.find(x => x.supplier_product_id === s.supplier_product_id);
    if (!s?.fallback || !l) return;
    Object.assign(l, { supplier_product_id: s.fallback.supplier_product_id, supplier_name: s.fallback.business_name, price: s.fallback.unit_price, qty: s.requested });
    SHORT = SHORT.filter(x => x !== s); drawCart(); toast('Switched supplier. Review the order and place it again.');
  },
  place: el => run(el, async () => {
    try {
      const r = await api('/api/orders', { method: 'POST', body: { items: CART.map(l => ({ supplier_product_id: l.supplier_product_id, quantity: l.qty })), shipping_address: $('#ship').value, payment_method: $('#pm').value } });
      CART = []; SHORT = []; toast(`Order ORD-${r.order_id} placed · stock reserved. Pay to confirm it.`); location.hash = '#orders';
    } catch (e) {
      if (e.status === 409 && e.data?.shortages) {
        SHORT = e.data.shortages;
        $('#fb').innerHTML = SHORT.map(s => `<div class="banner rd"><b>${esc(s.product_name)}</b> from ${esc(s.supplier_name)}: you asked for ${s.requested} but only ${s.available} are available now. The whole order was rolled back, nothing is reserved.
          ${s.fallback ? `<div class="row" style="margin-top:8px">Next best: <b>${esc(s.fallback.business_name)}</b> · ${inr(s.fallback.unit_price)} · ${s.fallback.lead_time_days} days <button class="sm" data-a="swap" data-sp="${s.supplier_product_id}">Switch supplier</button></div>` : '<div style="margin-top:6px">No other verified supplier has enough stock.</div>'}</div>`).join('');
      } else throw e;
    }
  })
};

/* ------------------------------------------------------------------ forms */
const F = {
  rank: async (f, d) => {
    const prod = f.product_id.selectedOptions[0].textContent.replace(/ \(.*\)$/, ''), unit = (f.product_id.selectedOptions[0].textContent.match(/\((.*)\)$/) || [])[1] || '';
    RCTX = { name: prod, unit, qty: +d.quantity };
    RANK = await api('/api/rank?' + new URLSearchParams(d)); drawRank();
  },
  track: async (f, d) => {
    try { const s = await api('/api/shipments/track/' + encodeURIComponent(d.no.trim())); $('#tr').innerHTML = shipCard(s); }
    catch (e) { $('#tr').innerHTML = `<div class="banner rd">${esc(e.message)}</div>`; }
  },
  receive: async (f, d) => { await api('/api/wm/inventory', { method: 'POST', body: d }); toast('Stock received'); await go(); },
  offer: async (f, d) => { await api('/api/supplier/offers', { method: 'POST', body: d }); toast('Offer published'); await go(); },
  cat: async (f, d) => { await api('/api/admin/categories', { method: 'POST', body: d }); toast('Category added'); await go(); },
  prod: async (f, d) => { await api('/api/admin/products', { method: 'POST', body: d }); toast('Product added'); await go(); },
  wh: async (f, d) => { await api('/api/admin/warehouses', { method: 'POST', body: { ...d, manager_id: d.manager_id || null } }); toast('Warehouse created'); await go(); },
  user: async (f, d) => {
    const b = { role: d.role, full_name: d.full_name, email: d.email, password: d.password, phone: d.phone };
    if (d.role === 'BUYER' || d.role === 'SUPPLIER') { const g = GEO[d.city]; Object.assign(b, { address: d.address, city: d.city, latitude: g[0], longitude: g[1] }); b[d.role === 'BUYER' ? 'company_name' : 'business_name'] = d.extra; }
    else if (d.role === 'WAREHOUSE_MANAGER') b.employee_code = d.extra; else b.designation = d.extra;
    await api('/api/admin/users', { method: 'POST', body: b }); toast('User created'); await go();
  }
};

/* ------------------------------------------------------------------ wiring */
const AFTER = {
  inventory() { invRows(); $('#f').oninput = invRows; },
  find() { drawCart(); catRows(); $('#cf').oninput = catRows; if (RANK.length) drawRank(); },
  users() { syncUserForm(); $('#nrole').onchange = syncUserForm; }
};
function syncUserForm() {
  const r = $('#nrole').value, geo = r === 'BUYER' || r === 'SUPPLIER';
  $('#xl').textContent = { ADMIN: 'Designation', BUYER: 'Company name', SUPPLIER: 'Business name', WAREHOUSE_MANAGER: 'Employee code' }[r];
  document.querySelectorAll('#nu .geo').forEach(e => { e.hidden = !geo; e.querySelector('input,select').required = geo; });
}
m.addEventListener('click', e => { const el = e.target.closest('[data-a]'); if (el && A[el.dataset.a]) A[el.dataset.a](el); });
m.addEventListener('submit', e => {
  const f = e.target.closest('form[data-f]'); if (!f) return;
  e.preventDefault();
  run(f.querySelector('button:not([type=button])'), () => F[f.dataset.f](f, Object.fromEntries(new FormData(f))));
});
m.addEventListener('input', e => {
  if (e.target.type === 'range') e.target.previousElementSibling.textContent = e.target.value;
});
m.addEventListener('change', e => {
  if (e.target.classList.contains('cq')) {
    const l = CART[+e.target.dataset.i], v = Math.floor(+e.target.value);
    l.qty = v >= l.moq ? v : l.moq; if (v < l.moq) toast(`Minimum order for this offer is ${l.moq}`); drawCart();
  }
});

async function go() {
  const my = ++tok, h = location.hash.slice(1) || 'dashboard', nav = NAV[me.role], pg = nav.some(x => x[0] === h) ? h : 'dashboard';
  $('#nav').innerHTML = nav.map(([k, l]) => `<a href="#${k}" class="${k === pg ? 'on' : ''}" ${k === pg ? 'aria-current="page"' : ''}>${l}</a>`).join('');
  try {
    const html = await V[pg]();
    if (my !== tok) return;
    m.innerHTML = html;
    if (AFTER[pg]) await AFTER[pg]();
  } catch (e) { if (my === tok && e.message !== 'Signed out') m.innerHTML = `<div class="banner rd">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', go);
$('#out').onclick = async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/login.html'; };
(async () => {
  me = await api('/api/auth/me');
  $('#uname').textContent = me.full_name; $('#urole').textContent = lbl(me.role) + (me.org ? ' · ' + me.org : '');
  document.title = 'Procura – ' + lbl(me.role);
  go();
})();
