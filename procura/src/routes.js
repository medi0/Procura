const express = require('express');
const pool = require('./db');
const { requireAuth, requireRole, createUser } = require('./auth');
const { HttpError, ah, posInt, str, num } = require('./util');
const { rank } = require('./ranking');
const svc = require('./orders');

const r = express.Router();
r.use(requireAuth);
const q = (sql, p = []) => pool.query(sql, p).then(([rows]) => rows);
const one = async (sql, p = []) => (await q(sql, p))[0];
const STAT = ['PLACED', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
const SHIP = ['PENDING', 'DISPATCHED', 'DELIVERED', 'CANCELLED'];
const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const counts = (rows, keys) => keys.map(k => rows.find(x => x.status === k)?.n || 0);
const cap = s => s.charAt(0) + s.slice(1).toLowerCase();

// ============================================================ DASHBOARD (role specific)
r.get('/dashboard', ah(async (req, res) => {
  const { id, role } = req.session.user;
  let d;
  if (role === 'ADMIN') {
    const st = await q('SELECT status, COUNT(*) n FROM ORDERS GROUP BY status');
    const v = await one("SELECT COALESCE(SUM(t.total_amount),0) val FROM ORDERS o JOIN v_order_totals t ON t.order_id=o.order_id WHERE o.status<>'CANCELLED'");
    const sup = await one("SELECT COALESCE(SUM(verification_status='VERIFIED'),0) ok, COUNT(*) total, COALESCE(SUM(verification_status='PENDING'),0) pend FROM SUPPLIER");
    const low = await q(`SELECT p.product_name, w.warehouse_name, i.available_quantity, i.reorder_level
      FROM INVENTORY i JOIN SUPPLIER_PRODUCT sp ON sp.supplier_product_id=i.supplier_product_id JOIN PRODUCT p ON p.product_id=sp.product_id
      JOIN WAREHOUSE w ON w.warehouse_id=i.warehouse_id WHERE i.available_quantity<=i.reorder_level ORDER BY i.available_quantity`);
    d = { title: 'Overview', subtitle: 'Live view of orders, stock and fulfilment',
      kpis: [{ label: 'Total order value', value: inr(v.val) }, { label: 'Orders placed', value: String(st.reduce((a, x) => a + x.n, 0)) },
             { label: 'Items at or below reorder level', value: String(low.length) },
             { label: 'Suppliers verified', value: `${sup.ok}/${sup.total}` }, { label: 'Suppliers awaiting verification', value: String(sup.pend) }],
      chart: { title: 'Orders by status', labels: STAT.map(cap), values: counts(st, STAT) },
      side: { title: 'Reorder alerts', empty: 'All stock healthy.', items: low.map(i => ({ t: i.product_name, s: `${i.warehouse_name} · ${i.available_quantity} available · reorder at ${i.reorder_level}` })) } };
  } else if (role === 'BUYER') {
    const st = await q('SELECT status, COUNT(*) n FROM v_buyer_orders WHERE buyer_id=? GROUP BY status', [id]);
    const v = await one("SELECT COALESCE(SUM(total_amount),0) val FROM v_buyer_orders WHERE buyer_id=? AND status<>'CANCELLED'", [id]);
    const open = await one("SELECT COUNT(*) n FROM v_buyer_shipments WHERE buyer_id=? AND shipment_status IN ('PENDING','DISPATCHED')", [id]);
    const unpaid = await q("SELECT order_id, total_amount, order_date FROM v_buyer_orders WHERE buyer_id=? AND status='PLACED' ORDER BY order_id DESC", [id]);
    d = { title: 'Overview', subtitle: 'Your orders, payments and shipments',
      kpis: [{ label: 'Total order value', value: inr(v.val) }, { label: 'Orders placed', value: String(st.reduce((a, x) => a + x.n, 0)) },
             { label: 'Open shipments', value: String(open.n) }, { label: 'Orders awaiting payment', value: String(unpaid.length) }],
      chart: { title: 'Your orders by status', labels: STAT.map(cap), values: counts(st, STAT) },
      side: { title: 'Awaiting payment', empty: 'Nothing to pay right now.', items: unpaid.map(o => ({ t: `ORD-${o.order_id} · ${inr(o.total_amount)}`, s: `Placed ${o.order_date.slice(0, 10)}` })) } };
  } else if (role === 'SUPPLIER') {
    const me = await one('SELECT verification_status, reliability_score FROM SUPPLIER WHERE user_id=?', [id]);
    const st = await q('SELECT status, COUNT(DISTINCT order_id) n FROM v_supplier_orders WHERE supplier_id=? GROUP BY status', [id]);
    const off = await one('SELECT COUNT(*) n FROM SUPPLIER_PRODUCT WHERE supplier_id=? AND is_active=TRUE', [id]);
    const low = await q('SELECT product_name, warehouse_name, available_quantity, reorder_level FROM v_supplier_inventory WHERE supplier_id=? AND available_quantity<=reorder_level', [id]);
    const rev = await one("SELECT COALESCE(SUM(line_total),0) val FROM v_supplier_orders WHERE supplier_id=? AND status<>'CANCELLED'", [id]);
    d = { title: 'Overview', subtitle: 'Your offers, stock and incoming orders',
      kpis: [{ label: 'Order value received', value: inr(rev.val) }, { label: 'Verification status', value: cap(me.verification_status) },
             { label: 'Active offers', value: String(off.n) }, { label: 'Items at or below reorder level', value: String(low.length) },
             { label: 'Reliability score', value: String(me.reliability_score) }],
      chart: { title: 'Orders for your offers', labels: STAT.map(cap), values: counts(st, STAT) },
      side: { title: 'Restocking list', empty: 'All your stock is healthy.', items: low.map(i => ({ t: i.product_name, s: `${i.warehouse_name} · ${i.available_quantity} available · reorder at ${i.reorder_level}` })) } };
  } else {
    const st = await q('SELECT shipment_status AS status, COUNT(*) n FROM v_warehouse_shipments WHERE manager_id=? GROUP BY shipment_status', [id]);
    const lines = await one('SELECT COUNT(*) n FROM v_warehouse_stock WHERE manager_id=?', [id]);
    const low = await q('SELECT product_name, warehouse_name, available_quantity, reorder_level FROM v_warehouse_stock WHERE manager_id=? AND available_quantity<=reorder_level', [id]);
    const c = counts(st, SHIP);
    d = { title: 'Overview', subtitle: 'Stock and dispatches in your warehouses',
      kpis: [{ label: 'Stock lines', value: String(lines.n) }, { label: 'Items at or below reorder level', value: String(low.length) },
             { label: 'Waiting to dispatch', value: String(c[0]) }, { label: 'In transit', value: String(c[1]) }],
      chart: { title: 'Shipments by status', labels: SHIP.map(cap), values: c },
      side: { title: 'Reorder alerts', empty: 'All stock healthy.', items: low.map(i => ({ t: i.product_name, s: `${i.warehouse_name} · ${i.available_quantity} available · reorder at ${i.reorder_level}` })) } };
  }
  res.json(d);
}));

// ============================================================ CATALOGUE (all roles read)
r.get('/products', ah(async (req, res) => res.json(await q(
  'SELECT p.product_id, p.product_name, p.unit, p.description, c.category_id, c.category_name FROM PRODUCT p JOIN CATEGORY c ON c.category_id=p.category_id ORDER BY c.category_name, p.product_name'))));
r.get('/categories', ah(async (req, res) => res.json(await q('SELECT category_id, category_name, description FROM CATEGORY ORDER BY category_name'))));

// ============================================================ BUYER: catalogue view + ranking + ordering
r.get('/catalog', requireRole('BUYER'), ah(async (req, res) =>
  res.json(await q('SELECT * FROM v_buyer_catalog ORDER BY product_name, unit_price'))));

r.get('/rank', requireRole('BUYER', 'ADMIN'), ah(async (req, res) => {
  const productId = posInt(req.query.product_id, 'Product'), quantity = posInt(req.query.quantity, 'Quantity');
  let lat = 20.5937, lng = 78.9629;                                   // India centroid for admins
  if (req.session.user.role === 'BUYER') ({ latitude: lat, longitude: lng } = await one('SELECT latitude, longitude FROM BUYER WHERE user_id=?', [req.session.user.id]));
  const rows = await rank({ productId, quantity, lat, lng,
    weights: { price: req.query.w_price, avail: req.query.w_avail, dist: req.query.w_dist, lead: req.query.w_lead, rel: req.query.w_rel } });
  // Buyers must not see the supplier reliability score (external schema) - it still counts in the score.
  res.json(req.session.user.role === 'ADMIN' ? rows : rows.map(({ reliability_score, supplier_id, ...x }) => x));
}));

r.post('/orders', requireRole('BUYER'), ah(async (req, res) =>
  res.status(201).json(await svc.placeOrder(req.session.user.id, req.body))));
r.post('/orders/:id/pay', requireRole('BUYER'), ah(async (req, res) =>
  res.json(await svc.payOrder(req.session.user.id, posInt(req.params.id, 'Order'), req.body || {}))));
r.post('/orders/:id/cancel', requireRole('BUYER', 'ADMIN'), ah(async (req, res) =>
  res.json(await svc.cancelOrder(req.session.user, posInt(req.params.id, 'Order')))));

// ============================================================ ORDERS (role scoped lists + detail)
r.get('/orders', ah(async (req, res) => {
  const { id, role } = req.session.user;
  if (role === 'BUYER') return res.json(await q('SELECT * FROM v_buyer_orders WHERE buyer_id=? ORDER BY order_id DESC', [id]));
  if (role === 'SUPPLIER') return res.json(await q('SELECT * FROM v_supplier_orders WHERE supplier_id=? ORDER BY order_id DESC', [id]));
  if (role === 'ADMIN') return res.json(await q(`SELECT o.order_id, o.order_date, o.status, o.invoice_number, b.company_name AS buyer,
      COALESCE(t.total_amount,0) AS total_amount,
      (SELECT p.payment_status FROM PAYMENT p WHERE p.order_id=o.order_id ORDER BY p.payment_id DESC LIMIT 1) AS payment_status
    FROM ORDERS o JOIN BUYER b ON b.user_id=o.buyer_id LEFT JOIN v_order_totals t ON t.order_id=o.order_id ORDER BY o.order_id DESC`));
  throw new HttpError(403, 'Your role cannot view orders');
}));

r.get('/orders/:id', requireRole('BUYER', 'ADMIN'), ah(async (req, res) => {
  const oid = posInt(req.params.id, 'Order'), { id, role } = req.session.user;
  if (role === 'BUYER') {
    const order = await one('SELECT * FROM v_buyer_orders WHERE order_id=? AND buyer_id=?', [oid, id]);
    if (!order) throw new HttpError(404, 'Order not found');
    return res.json({ order,
      items: await q('SELECT * FROM v_buyer_order_items WHERE order_id=? AND buyer_id=? ORDER BY order_item_id', [oid, id]),
      shipments: await q('SELECT * FROM v_buyer_shipments WHERE order_id=? AND buyer_id=?', [oid, id]),
      payments: await q('SELECT * FROM v_buyer_payments WHERE order_id=? AND buyer_id=? ORDER BY payment_id', [oid, id]) });
  }
  const order = await one(`SELECT o.order_id, o.order_date, o.status, o.shipping_address, o.invoice_number, b.company_name AS buyer,
      COALESCE(t.total_amount,0) AS total_amount FROM ORDERS o JOIN BUYER b ON b.user_id=o.buyer_id LEFT JOIN v_order_totals t ON t.order_id=o.order_id WHERE o.order_id=?`, [oid]);
  if (!order) throw new HttpError(404, 'Order not found');
  res.json({ order,
    items: await q(`SELECT oi.order_item_id, p.product_name, p.unit, s.business_name AS supplier_name, w.city AS warehouse_city, oi.quantity, oi.unit_price, oi.line_total
      FROM ORDER_ITEM oi JOIN INVENTORY i ON i.inventory_id=oi.inventory_id JOIN WAREHOUSE w ON w.warehouse_id=i.warehouse_id
      JOIN SUPPLIER_PRODUCT sp ON sp.supplier_product_id=i.supplier_product_id JOIN PRODUCT p ON p.product_id=sp.product_id
      JOIN SUPPLIER s ON s.user_id=sp.supplier_id WHERE oi.order_id=? ORDER BY oi.order_item_id`, [oid]),
    shipments: await q(`SELECT sh.*, o.status AS order_status, w.city AS warehouse_city FROM SHIPMENT sh JOIN WAREHOUSE w ON w.warehouse_id=sh.warehouse_id JOIN ORDERS o ON o.order_id=sh.order_id WHERE sh.order_id=?`, [oid]),
    payments: await q('SELECT * FROM PAYMENT WHERE order_id=? ORDER BY payment_id', [oid]) });
}));

// ============================================================ INVENTORY
r.get('/inventory', ah(async (req, res) => {
  const { id, role } = req.session.user;
  if (role === 'ADMIN') return res.json(await q(`SELECT i.inventory_id, p.product_name, p.unit, s.business_name AS supplier_name, w.warehouse_name, w.city AS warehouse_city,
      i.quantity_on_hand, i.reserved_quantity, i.available_quantity, i.reorder_level
    FROM INVENTORY i JOIN SUPPLIER_PRODUCT sp ON sp.supplier_product_id=i.supplier_product_id JOIN PRODUCT p ON p.product_id=sp.product_id
    JOIN SUPPLIER s ON s.user_id=sp.supplier_id JOIN WAREHOUSE w ON w.warehouse_id=i.warehouse_id ORDER BY p.product_name, w.warehouse_name`));
  if (role === 'SUPPLIER') return res.json(await q('SELECT * FROM v_supplier_inventory WHERE supplier_id=? ORDER BY product_name', [id]));
  if (role === 'WAREHOUSE_MANAGER') return res.json(await q('SELECT * FROM v_warehouse_stock WHERE manager_id=? ORDER BY product_name', [id]));
  throw new HttpError(403, 'Your role cannot view inventory');
}));

// Warehouse manager: receive stock (creates the stock row if the offer is new to this warehouse)
r.get('/wm/warehouses', requireRole('WAREHOUSE_MANAGER'), ah(async (req, res) =>
  res.json(await q('SELECT warehouse_id, warehouse_name, city FROM WAREHOUSE WHERE manager_id=? ORDER BY warehouse_name', [req.session.user.id]))));
r.get('/wm/offers', requireRole('WAREHOUSE_MANAGER'), ah(async (req, res) =>
  res.json(await q(`SELECT sp.supplier_product_id, p.product_name, p.unit, s.business_name AS supplier_name FROM SUPPLIER_PRODUCT sp
    JOIN PRODUCT p ON p.product_id=sp.product_id JOIN SUPPLIER s ON s.user_id=sp.supplier_id WHERE sp.is_active=TRUE AND s.verification_status='VERIFIED'
    ORDER BY p.product_name, s.business_name`))));
r.post('/wm/inventory', requireRole('WAREHOUSE_MANAGER'), ah(async (req, res) => {
  const wh = posInt(req.body.warehouse_id, 'Warehouse'), sp = posInt(req.body.supplier_product_id, 'Offer'), qty = posInt(req.body.quantity, 'Quantity');
  const lvlRaw = req.body.reorder_level;
  const lvl = lvlRaw === '' || lvlRaw === undefined || lvlRaw === null ? null : num(lvlRaw, 'Reorder level', 0, 10000000);
  const mine = await one('SELECT warehouse_id FROM WAREHOUSE WHERE warehouse_id=? AND manager_id=?', [wh, req.session.user.id]);
  if (!mine) throw new HttpError(403, 'You do not manage this warehouse');
  await pool.execute(`INSERT INTO INVENTORY(supplier_product_id, warehouse_id, quantity_on_hand, reserved_quantity, reorder_level) VALUES(?,?,?,0,COALESCE(?,0))
    ON DUPLICATE KEY UPDATE quantity_on_hand = quantity_on_hand + VALUES(quantity_on_hand), reorder_level = COALESCE(?, reorder_level)`, [sp, wh, qty, lvl, lvl]);
  res.status(201).json({ ok: true });
}));

// ============================================================ SHIPMENTS
r.get('/shipments', ah(async (req, res) => {
  const { id, role } = req.session.user;
  if (role === 'BUYER') return res.json(await q('SELECT * FROM v_buyer_shipments WHERE buyer_id=? ORDER BY shipment_id DESC', [id]));
  if (role === 'WAREHOUSE_MANAGER') return res.json(await q('SELECT * FROM v_warehouse_shipments WHERE manager_id=? ORDER BY shipment_id DESC', [id]));
  if (role === 'ADMIN') return res.json(await q(`SELECT sh.shipment_id, sh.order_id, o.status AS order_status, sh.tracking_number, sh.shipment_status, sh.dispatch_date,
      sh.expected_delivery_date, sh.delivered_date, w.warehouse_name, w.city AS warehouse_city, b.company_name AS buyer
    FROM SHIPMENT sh JOIN ORDERS o ON o.order_id=sh.order_id JOIN WAREHOUSE w ON w.warehouse_id=sh.warehouse_id JOIN BUYER b ON b.user_id=o.buyer_id ORDER BY sh.shipment_id DESC`));
  throw new HttpError(403, 'Your role cannot view shipments');
}));
r.get('/shipments/track/:no', requireRole('BUYER', 'ADMIN'), ah(async (req, res) => {
  const no = str(req.params.no, 'Tracking number', 40);
  const row = req.session.user.role === 'BUYER'
    ? await one('SELECT * FROM v_buyer_shipments WHERE tracking_number=? AND buyer_id=?', [no, req.session.user.id])
    : await one(`SELECT sh.*, o.status AS order_status, w.city AS warehouse_city FROM SHIPMENT sh JOIN ORDERS o ON o.order_id=sh.order_id JOIN WAREHOUSE w ON w.warehouse_id=sh.warehouse_id WHERE sh.tracking_number=?`, [no]);
  if (!row) throw new HttpError(404, 'No shipment found with that tracking number');
  res.json(row);
}));
r.post('/shipments/:id/dispatch', requireRole('WAREHOUSE_MANAGER', 'ADMIN'), ah(async (req, res) =>
  res.json(await svc.dispatchShipment(req.session.user, posInt(req.params.id, 'Shipment')))));
r.post('/shipments/:id/deliver', requireRole('WAREHOUSE_MANAGER', 'ADMIN'), ah(async (req, res) =>
  res.json(await svc.deliverShipment(req.session.user, posInt(req.params.id, 'Shipment')))));

// ============================================================ SUPPLIER: own offers
r.get('/supplier/offers', requireRole('SUPPLIER'), ah(async (req, res) =>
  res.json(await q(`SELECT sp.supplier_product_id, p.product_id, p.product_name, p.unit, c.category_name, sp.unit_price, sp.min_order_qty, sp.lead_time_days, sp.is_active
    FROM SUPPLIER_PRODUCT sp JOIN PRODUCT p ON p.product_id=sp.product_id JOIN CATEGORY c ON c.category_id=p.category_id WHERE sp.supplier_id=? ORDER BY p.product_name`, [req.session.user.id]))));
r.post('/supplier/offers', requireRole('SUPPLIER'), ah(async (req, res) => {
  const b = req.body;
  await pool.execute('INSERT INTO SUPPLIER_PRODUCT(supplier_id, product_id, unit_price, min_order_qty, lead_time_days) VALUES(?,?,?,?,?)',
    [req.session.user.id, posInt(b.product_id, 'Product'), num(b.unit_price, 'Unit price', 0.01, 100000000), posInt(b.min_order_qty, 'Minimum order'), num(b.lead_time_days, 'Lead time', 0, 365)]);
  res.status(201).json({ ok: true });
}));
r.patch('/supplier/offers/:id', requireRole('SUPPLIER'), ah(async (req, res) => {
  const b = req.body;
  const [u] = await pool.execute('UPDATE SUPPLIER_PRODUCT SET unit_price=?, min_order_qty=?, lead_time_days=?, is_active=? WHERE supplier_product_id=? AND supplier_id=?',
    [num(b.unit_price, 'Unit price', 0.01, 100000000), posInt(b.min_order_qty, 'Minimum order'), num(b.lead_time_days, 'Lead time', 0, 365), b.is_active ? 1 : 0, posInt(req.params.id, 'Offer'), req.session.user.id]);
  if (!u.affectedRows) throw new HttpError(404, 'Offer not found');
  res.json({ ok: true });                                   // existing orders keep their locked price
}));

// ============================================================ ADMIN
const admin = express.Router();
admin.use(requireRole('ADMIN'));

admin.get('/suppliers', ah(async (req, res) => res.json(await q(
  `SELECT s.user_id, s.business_name, s.city, s.verification_status, s.reliability_score, u.email, u.is_active,
          (SELECT COUNT(*) FROM SUPPLIER_PRODUCT sp WHERE sp.supplier_id=s.user_id) AS listings
   FROM SUPPLIER s JOIN USERS u ON u.user_id=s.user_id ORDER BY FIELD(s.verification_status,'PENDING','VERIFIED','REJECTED'), s.business_name`))));
admin.post('/suppliers/:id/verification', ah(async (req, res) => {
  const id = posInt(req.params.id, 'Supplier');
  const st = req.body.status, score = req.body.reliability_score;
  if (st !== undefined && !['PENDING', 'VERIFIED', 'REJECTED'].includes(st)) throw new HttpError(400, 'Invalid status');
  const s = score === undefined || score === '' ? null : num(score, 'Reliability score', 0, 100);
  const [u] = await pool.execute('UPDATE SUPPLIER SET verification_status=COALESCE(?,verification_status), reliability_score=COALESCE(?,reliability_score) WHERE user_id=?', [st ?? null, s, id]);
  if (!u.affectedRows) throw new HttpError(404, 'Supplier not found');
  res.json({ ok: true });
}));
admin.get('/offers', ah(async (req, res) => res.json(await q(
  `SELECT p.product_name, p.unit, s.business_name AS supplier_name, sp.unit_price, sp.lead_time_days, sp.min_order_qty, sp.is_active
   FROM SUPPLIER_PRODUCT sp JOIN PRODUCT p ON p.product_id=sp.product_id JOIN SUPPLIER s ON s.user_id=sp.supplier_id ORDER BY p.product_name, sp.unit_price`))));

admin.post('/categories', ah(async (req, res) => {
  await pool.execute('INSERT INTO CATEGORY(category_name, description) VALUES(?,?)', [str(req.body.category_name, 'Category name', 80), str(req.body.description, 'Description', 255, false) || null]);
  res.status(201).json({ ok: true });
}));
admin.post('/products', ah(async (req, res) => {
  await pool.execute('INSERT INTO PRODUCT(category_id, product_name, description, unit) VALUES(?,?,?,?)',
    [posInt(req.body.category_id, 'Category'), str(req.body.product_name, 'Product name', 120), str(req.body.description, 'Description', 255, false) || null, str(req.body.unit, 'Unit', 20)]);
  res.status(201).json({ ok: true });
}));

admin.get('/warehouses', ah(async (req, res) => res.json(await q(
  `SELECT w.warehouse_id, w.warehouse_name, w.address, w.city, w.manager_id, u.full_name AS manager_name FROM WAREHOUSE w LEFT JOIN USERS u ON u.user_id=w.manager_id ORDER BY w.warehouse_name`))));
admin.post('/warehouses', ah(async (req, res) => {
  const mgr = req.body.manager_id ? posInt(req.body.manager_id, 'Manager') : null;
  await pool.execute('INSERT INTO WAREHOUSE(warehouse_name, address, city, manager_id) VALUES(?,?,?,?)',
    [str(req.body.warehouse_name, 'Warehouse name', 80), str(req.body.address, 'Address', 255, false) || null, str(req.body.city, 'City', 60), mgr]);   // trigger checks the role
  res.status(201).json({ ok: true });
}));
admin.patch('/warehouses/:id/manager', ah(async (req, res) => {
  const mgr = req.body.manager_id ? posInt(req.body.manager_id, 'Manager') : null;
  const [u] = await pool.execute('UPDATE WAREHOUSE SET manager_id=? WHERE warehouse_id=?', [mgr, posInt(req.params.id, 'Warehouse')]);
  if (!u.affectedRows) throw new HttpError(404, 'Warehouse not found');
  res.json({ ok: true });
}));

admin.get('/users', ah(async (req, res) => {
  const role = req.query.role;
  res.json(await q(`SELECT u.user_id, u.full_name, u.email, u.role, u.is_active, u.created_at,
      (SELECT GROUP_CONCAT(phone SEPARATOR ', ') FROM USER_PHONE ph WHERE ph.user_id=u.user_id) AS phones
    FROM USERS u ${role ? 'WHERE u.role=?' : ''} ORDER BY u.role, u.full_name`, role ? [role] : []));
}));
admin.post('/users', ah(async (req, res) => res.status(201).json({ user_id: await createUser(req.body) })));
admin.patch('/users/:id/active', ah(async (req, res) => {
  const id = posInt(req.params.id, 'User');
  if (id === req.session.user.id) throw new HttpError(400, 'You cannot deactivate your own account');
  await pool.execute('UPDATE USERS SET is_active=? WHERE user_id=?', [req.body.is_active ? 1 : 0, id]);
  res.json({ ok: true });
}));
admin.get('/payments', ah(async (req, res) => res.json(await q(
  `SELECT pay.payment_id, pay.order_id, b.company_name AS buyer, pay.amount, pay.payment_method, pay.payment_status, pay.transaction_ref, pay.payment_date
   FROM PAYMENT pay JOIN ORDERS o ON o.order_id=pay.order_id JOIN BUYER b ON b.user_id=o.buyer_id ORDER BY pay.payment_id DESC`))));

r.use('/admin', admin);
module.exports = r;
