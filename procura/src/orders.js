// Transactional order logic: place (reserve stock), pay, cancel, dispatch, deliver.
const pool = require('./db');
const { HttpError } = require('./util');
const { rank } = require('./ranking');

const METHODS = ['UPI', 'CARD', 'NETBANKING', 'BANK_TRANSFER'];
const txnRef = () => 'TXN-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();

// Retry the whole transaction when InnoDB picks it as a deadlock victim.
async function withTx(fn, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    const cn = await pool.getConnection();
    try {
      await cn.beginTransaction();
      const out = await fn(cn);
      await cn.commit();
      return out;
    } catch (e) {
      try { await cn.rollback(); } catch (_) {}
      if ((e.code === 'ER_LOCK_DEADLOCK' || e.code === 'ER_LOCK_WAIT_TIMEOUT') && attempt < tries) {
        await new Promise(r => setTimeout(r, 40 * attempt)); continue;
      }
      throw e;
    } finally { cn.release(); }
  }
}

// ---------------------------------------------------------------- PLACE ORDER
async function placeOrder(buyerId, { items, shipping_address, payment_method }) {
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Add at least one item to the order');
  const merged = new Map();
  for (const it of items) {
    const id = Number(it.supplier_product_id), q = Number(it.quantity);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(q) || q <= 0) throw new HttpError(400, 'Each item needs a valid offer and a whole-number quantity');
    merged.set(id, (merged.get(id) || 0) + q);
  }
  const method = METHODS.includes(payment_method) ? payment_method : 'UPI';
  const spIds = [...merged.keys()];

  try {
    return await withTx(async cn => {
      const [[buyer]] = await cn.execute('SELECT address, city FROM BUYER WHERE user_id=?', [buyerId]);
      const [offers] = await cn.query(
        `SELECT sp.supplier_product_id, sp.supplier_id, sp.product_id, sp.unit_price, sp.min_order_qty, sp.lead_time_days,
                p.product_name, s.business_name
           FROM SUPPLIER_PRODUCT sp JOIN PRODUCT p ON p.product_id = sp.product_id
           JOIN SUPPLIER s ON s.user_id = sp.supplier_id AND s.verification_status = 'VERIFIED'
           JOIN USERS u ON u.user_id = s.user_id AND u.is_active = TRUE
          WHERE sp.is_active = TRUE AND sp.supplier_product_id IN (?)`, [spIds]);
      const byId = new Map(offers.map(o => [o.supplier_product_id, o]));
      for (const [id, q] of merged) {
        const o = byId.get(id);
        if (!o) throw new HttpError(400, 'One of the offers is no longer available from a verified supplier');
        if (q < o.min_order_qty) throw new HttpError(400, `${o.product_name} from ${o.business_name}: minimum order is ${o.min_order_qty}`);
      }

      // Candidate stock rows; lock them ALL in ascending inventory_id order (deadlock avoidance).
      const [cands] = await cn.query(
        `SELECT i.inventory_id FROM INVENTORY i WHERE i.supplier_product_id IN (?)`, [spIds]);
      const lockIds = cands.map(c => c.inventory_id).sort((a, b) => a - b);
      let locked = [];
      if (lockIds.length) {
        [locked] = await cn.query(
          `SELECT i.inventory_id, i.supplier_product_id, i.warehouse_id, i.quantity_on_hand, i.reserved_quantity, w.city
             FROM INVENTORY i JOIN WAREHOUSE w ON w.warehouse_id = i.warehouse_id
            WHERE i.inventory_id IN (?) ORDER BY i.inventory_id FOR UPDATE`, [lockIds]);   // row locks
      }

      // Allocate each line: buyer's city first, then largest stock; may split across warehouses.
      const lines = [], shortages = [];
      for (const [spId, qty] of merged) {
        const o = byId.get(spId);
        const rows = locked.filter(r => r.supplier_product_id === spId && r.quantity_on_hand - r.reserved_quantity > 0)
          .sort((a, b) => (b.city === buyer.city) - (a.city === buyer.city)
                       || (b.quantity_on_hand - b.reserved_quantity) - (a.quantity_on_hand - a.reserved_quantity));
        let left = qty;
        for (const r of rows) {
          if (left <= 0) break;
          const take = Math.min(left, r.quantity_on_hand - r.reserved_quantity);
          lines.push({ inv: r, offer: o, qty: take });
          left -= take;
        }
        if (left > 0) shortages.push({ supplier_product_id: spId, product_id: o.product_id, supplier_id: o.supplier_id,
          product_name: o.product_name, supplier_name: o.business_name, requested: qty, available: qty - left });
      }
      if (shortages.length) throw new HttpError(409, 'Not enough stock for part of this order', { shortages });

      const [ord] = await cn.execute('INSERT INTO ORDERS(buyer_id, shipping_address) VALUES(?,?)',
        [buyerId, (shipping_address || '').trim() || buyer.address]);
      const orderId = ord.insertId;
      let n = 0, total = 0;
      const perWh = new Map();
      for (const l of lines) {
        await cn.execute('INSERT INTO ORDER_ITEM(order_id, order_item_id, inventory_id, quantity, unit_price) VALUES(?,?,?,?,?)',
          [orderId, ++n, l.inv.inventory_id, l.qty, l.offer.unit_price]);       // price locked here
        await cn.execute('UPDATE INVENTORY SET reserved_quantity = reserved_quantity + ? WHERE inventory_id = ?', [l.qty, l.inv.inventory_id]);
        total += l.qty * l.offer.unit_price;
        perWh.set(l.inv.warehouse_id, Math.max(perWh.get(l.inv.warehouse_id) || 0, l.offer.lead_time_days));
      }
      const shipments = [];
      for (const [wh, lead] of perWh) {
        const tracking = `PRC-${String(orderId).padStart(5, '0')}-W${wh}`;
        await cn.execute('INSERT INTO SHIPMENT(order_id, warehouse_id, tracking_number, expected_delivery_date) VALUES(?,?,?,DATE_ADD(CURDATE(), INTERVAL ? DAY))',
          [orderId, wh, tracking, lead + 1]);
        shipments.push(tracking);
      }
      await cn.execute('INSERT INTO PAYMENT(order_id, amount, payment_method, payment_status, transaction_ref) VALUES(?,?,?,?,?)',
        [orderId, total, method, 'PENDING', txnRef()]);
      return { order_id: orderId, total, shipments };
    });
  } catch (e) {
    if (e.status === 409 && e.extra?.shortages) {            // suggest the next-ranked supplier per short line
      const [[b]] = await pool.execute('SELECT latitude, longitude FROM BUYER WHERE user_id=?', [buyerId]);
      for (const s of e.extra.shortages) {
        const alt = await rank({ productId: s.product_id, quantity: s.requested, lat: b.latitude, lng: b.longitude, excludeSupplier: s.supplier_id });
        s.fallback = alt[0] ? { supplier_product_id: alt[0].supplier_product_id, business_name: alt[0].business_name,
          unit_price: alt[0].unit_price, lead_time_days: alt[0].lead_time_days, available: alt[0].available } : null;
      }
    }
    throw e;
  }
}

// ---------------------------------------------------------------- PAYMENT
async function payOrder(buyerId, orderId, { method, simulate }) {
  const m = METHODS.includes(method) ? method : 'UPI';
  return withTx(async cn => {
    const [[o]] = await cn.execute('SELECT order_id, buyer_id, status FROM ORDERS WHERE order_id=? FOR UPDATE', [orderId]);
    if (!o || o.buyer_id !== buyerId) throw new HttpError(404, 'Order not found');
    if (o.status !== 'PLACED') throw new HttpError(409, o.status === 'CANCELLED' ? 'This order was cancelled' : 'This order is already paid');
    const [[t]] = await cn.execute('SELECT SUM(line_total) AS total FROM ORDER_ITEM WHERE order_id=?', [orderId]);
    const [[pend]] = await cn.execute("SELECT payment_id FROM PAYMENT WHERE order_id=? AND payment_status='PENDING' ORDER BY payment_id DESC LIMIT 1 FOR UPDATE", [orderId]);
    const status = simulate === 'fail' ? 'FAILED' : 'COMPLETED';
    if (pend) await cn.execute('UPDATE PAYMENT SET payment_status=?, payment_method=?, payment_date=NOW() WHERE payment_id=?', [status, m, pend.payment_id]);
    else await cn.execute('INSERT INTO PAYMENT(order_id, amount, payment_method, payment_status, transaction_ref) VALUES(?,?,?,?,?)', [orderId, t.total, m, status, txnRef()]);
    if (status === 'COMPLETED') {
      await cn.execute("UPDATE ORDERS SET status='CONFIRMED', invoice_number=? WHERE order_id=?", [`INV-${orderId}`, orderId]);
    }
    return { status, invoice_number: status === 'COMPLETED' ? `INV-${orderId}` : null };
  });
}

// ---------------------------------------------------------------- CANCEL (releases stock, refunds)
async function cancelOrder(user, orderId) {
  return withTx(async cn => {
    const [[o]] = await cn.execute('SELECT order_id, buyer_id, status FROM ORDERS WHERE order_id=? FOR UPDATE', [orderId]);
    if (!o || (user.role === 'BUYER' && o.buyer_id !== user.id)) throw new HttpError(404, 'Order not found');
    if (!['PLACED', 'CONFIRMED'].includes(o.status)) throw new HttpError(409, `A ${o.status.toLowerCase()} order can no longer be cancelled`);
    await cn.execute('SELECT inventory_id FROM INVENTORY WHERE inventory_id IN (SELECT inventory_id FROM ORDER_ITEM WHERE order_id=?) ORDER BY inventory_id FOR UPDATE', [orderId]);
    await cn.execute('UPDATE INVENTORY i JOIN ORDER_ITEM oi ON oi.inventory_id = i.inventory_id SET i.reserved_quantity = i.reserved_quantity - oi.quantity WHERE oi.order_id = ?', [orderId]);
    await cn.execute("UPDATE PAYMENT SET payment_status='REFUNDED' WHERE order_id=? AND payment_status='COMPLETED'", [orderId]);
    await cn.execute("UPDATE PAYMENT SET payment_status='FAILED' WHERE order_id=? AND payment_status='PENDING'", [orderId]);
    await cn.execute("UPDATE SHIPMENT SET shipment_status='CANCELLED' WHERE order_id=?", [orderId]);
    await cn.execute("UPDATE ORDERS SET status='CANCELLED' WHERE order_id=?", [orderId]);
    return { status: 'CANCELLED' };
  });
}

// ---------------------------------------------------------------- SHIPMENTS
async function lockShipment(cn, user, shipmentId) {
  const [[s]] = await cn.execute(
    `SELECT sh.shipment_id, sh.order_id, sh.warehouse_id, sh.shipment_status, w.manager_id, o.status AS order_status
       FROM SHIPMENT sh JOIN WAREHOUSE w ON w.warehouse_id = sh.warehouse_id JOIN ORDERS o ON o.order_id = sh.order_id
      WHERE sh.shipment_id = ? FOR UPDATE`, [shipmentId]);
  if (!s || (user.role === 'WAREHOUSE_MANAGER' && s.manager_id !== user.id)) throw new HttpError(404, 'Shipment not found');
  return s;
}

async function dispatchShipment(user, shipmentId) {
  return withTx(async cn => {
    const s = await lockShipment(cn, user, shipmentId);
    if (s.shipment_status !== 'PENDING') throw new HttpError(409, 'This shipment has already been dispatched or cancelled');
    if (!['CONFIRMED', 'PROCESSING'].includes(s.order_status)) throw new HttpError(409, 'The order must be paid before dispatch');
    await cn.execute('SELECT i.inventory_id FROM INVENTORY i JOIN ORDER_ITEM oi ON oi.inventory_id = i.inventory_id WHERE oi.order_id=? AND i.warehouse_id=? ORDER BY i.inventory_id FOR UPDATE', [s.order_id, s.warehouse_id]);
    await cn.execute(
      `UPDATE INVENTORY i JOIN ORDER_ITEM oi ON oi.inventory_id = i.inventory_id
          SET i.quantity_on_hand = i.quantity_on_hand - oi.quantity, i.reserved_quantity = i.reserved_quantity - oi.quantity
        WHERE oi.order_id = ? AND i.warehouse_id = ?`, [s.order_id, s.warehouse_id]);
    await cn.execute("UPDATE SHIPMENT SET shipment_status='DISPATCHED', dispatch_date=CURDATE() WHERE shipment_id=?", [shipmentId]);
    const [[left]] = await cn.execute("SELECT COUNT(*) AS n FROM SHIPMENT WHERE order_id=? AND shipment_status='PENDING'", [s.order_id]);
    await cn.execute('UPDATE ORDERS SET status=? WHERE order_id=?', [left.n ? 'PROCESSING' : 'SHIPPED', s.order_id]);
    return { status: 'DISPATCHED' };
  });
}

async function deliverShipment(user, shipmentId) {
  return withTx(async cn => {
    const s = await lockShipment(cn, user, shipmentId);
    if (s.shipment_status !== 'DISPATCHED') throw new HttpError(409, 'Only a dispatched shipment can be marked delivered');
    await cn.execute("UPDATE SHIPMENT SET shipment_status='DELIVERED', delivered_date=CURDATE() WHERE shipment_id=?", [shipmentId]);
    const [[left]] = await cn.execute("SELECT COUNT(*) AS n FROM SHIPMENT WHERE order_id=? AND shipment_status NOT IN ('DELIVERED','CANCELLED')", [s.order_id]);
    if (!left.n) await cn.execute("UPDATE ORDERS SET status='DELIVERED' WHERE order_id=?", [s.order_id]);
    return { status: 'DELIVERED' };
  });
}

module.exports = { placeOrder, payOrder, cancelOrder, dispatchShipment, deliverShipment, METHODS };
