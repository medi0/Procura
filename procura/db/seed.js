// Loads demo data. Run after db:init.  Uses the same service code as the app,
// so the sample orders, reservations, shipments and payments are all consistent.
require('dotenv').config();
const pool = require('../src/db');
const { createUser } = require('../src/auth');
const svc = require('../src/orders');

const CITY = {
  Delhi: [28.6139, 77.2090], Pune: [18.5204, 73.8567], Jaipur: [26.9124, 75.7873], Surat: [21.1702, 72.8311],
  Hyderabad: [17.3850, 78.4867], Mumbai: [19.0760, 72.8777], Bengaluru: [12.9716, 77.5946]
};
const geo = c => ({ city: c, latitude: CITY[c][0], longitude: CITY[c][1] });

(async () => {
  const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM USERS');
  if (n) { console.log('Database already has data - skipping seed (run npm run db:init to reset).'); return pool.end(); }

  // ---- users
  const admin = await createUser({ role: 'ADMIN', full_name: 'Aarav Mehta', email: 'admin@procura.com', password: 'Admin@123', phone: '9810000001', designation: 'System Administrator' });
  const buyers = [];
  for (const [name, co, email, c, addr] of [
    ['Rohan Kapoor', 'Skyline Builders', 'buyer1@skyline.com', 'Delhi', '12 Okhla Industrial Area, New Delhi'],
    ['Neha Joshi', 'Urban Infra Co', 'buyer2@urbaninfra.com', 'Pune', '44 Hinjewadi Phase 2, Pune'],
    ['Imran Shaikh', 'GreenGrid Energy', 'buyer3@greengrid.com', 'Surat', '9 Sachin GIDC, Surat']])
    buyers.push(await createUser({ role: 'BUYER', full_name: name, company_name: co, email, password: 'Buyer@123', phone: '9820000000', address: addr, ...geo(c) }));
  const sup = {};
  for (const [key, name, co, email, c, rel, st] of [
    ['bharat', 'Vikram Singh', 'Bharat Metals', 'sales@bharatmetals.in', 'Jaipur', 92, 'VERIFIED'],
    ['volt', 'Anil Rao', 'VoltLine Traders', 'sales@voltline.in', 'Pune', 78, 'VERIFIED'],
    ['aqua', 'Kiran Patel', 'AquaFlow Pvt Ltd', 'sales@aquaflow.in', 'Surat', 64, 'PENDING'],
    ['raj', 'Sunita Verma', 'Rajdhani Cements', 'sales@rajdhani.in', 'Delhi', 88, 'VERIFIED'],
    ['deccan', 'Ravi Teja', 'Deccan Steels', 'sales@deccansteels.in', 'Hyderabad', 81, 'VERIFIED']]) {
    sup[key] = await createUser({ role: 'SUPPLIER', full_name: name, business_name: co, email, password: 'Supplier@123', phone: '9830000000', address: `Industrial Estate, ${c}`, ...geo(c) });
    await pool.execute('UPDATE SUPPLIER SET verification_status=?, reliability_score=? WHERE user_id=?', [st, rel, sup[key]]);
  }
  const wmDelhi = await createUser({ role: 'WAREHOUSE_MANAGER', full_name: 'Deepak Chauhan', email: 'wm.delhi@procura.com', password: 'Warehouse@123', employee_code: 'EMP-D01' });
  const wmPune = await createUser({ role: 'WAREHOUSE_MANAGER', full_name: 'Sneha Kulkarni', email: 'wm.pune@procura.com', password: 'Warehouse@123', employee_code: 'EMP-P01' });

  // ---- catalogue
  const cat = {};
  for (const [k, d] of [['Construction', 'Building materials'], ['Electrical', 'Wires, lighting and switchgear'], ['Plumbing', 'Pipes and fittings']])
    cat[k] = (await pool.execute('INSERT INTO CATEGORY(category_name, description) VALUES(?,?)', [k, d]))[0].insertId;
  const prod = {};
  for (const [k, c, u] of [['Steel rebar 12mm', 'Construction', 'tonne'], ['Cement OPC 53', 'Construction', 'bag'], ['Copper wire 2.5mm', 'Electrical', 'roll'],
                           ['LED panel 40W', 'Electrical', 'piece'], ['MCB 32A', 'Electrical', 'piece'], ['HDPE pipe 50mm', 'Plumbing', 'metre']])
    prod[k] = (await pool.execute('INSERT INTO PRODUCT(category_id, product_name, unit) VALUES(?,?,?)', [cat[c], k, u]))[0].insertId;

  // ---- offers  [supplier, product, price, lead days, min qty]
  const off = {};
  for (const [s, p, price, lead, moq] of [
    ['bharat', 'Steel rebar 12mm', 61500, 5, 10], ['raj', 'Steel rebar 12mm', 63000, 6, 5], ['deccan', 'Steel rebar 12mm', 60800, 8, 10],
    ['raj', 'Cement OPC 53', 385, 2, 100], ['deccan', 'Cement OPC 53', 379, 5, 100], ['bharat', 'Cement OPC 53', 372, 6, 200],
    ['volt', 'Copper wire 2.5mm', 4200, 3, 5], ['volt', 'LED panel 40W', 890, 4, 50], ['volt', 'MCB 32A', 215, 3, 20], ['aqua', 'HDPE pipe 50mm', 310, 7, 100]])
    off[s + '|' + p] = (await pool.execute('INSERT INTO SUPPLIER_PRODUCT(supplier_id, product_id, unit_price, min_order_qty, lead_time_days) VALUES(?,?,?,?,?)', [sup[s], prod[p], price, moq, lead]))[0].insertId;

  // ---- warehouses (Jaipur Yard has no manager yet - assign one from the Admin > Warehouses page)
  const wh = {};
  for (const [k, name, c, mgr] of [['delhi', 'Delhi Hub', 'Delhi', wmDelhi], ['pune', 'Pune Depot', 'Pune', wmPune], ['jaipur', 'Jaipur Yard', 'Jaipur', null]])
    wh[k] = (await pool.execute('INSERT INTO WAREHOUSE(warehouse_name, address, city, manager_id) VALUES(?,?,?,?)', [name, `Logistics Park, ${c}`, c, mgr]))[0].insertId;

  // ---- stock  [offer, warehouse, on hand, reorder level]
  for (const [o, w, qty, lvl] of [
    ['bharat|Steel rebar 12mm', 'delhi', 120, 40], ['bharat|Steel rebar 12mm', 'jaipur', 80, 30], ['raj|Steel rebar 12mm', 'delhi', 22, 25],
    ['deccan|Steel rebar 12mm', 'pune', 200, 50], ['raj|Cement OPC 53', 'delhi', 900, 300], ['raj|Cement OPC 53', 'pune', 400, 300],
    ['deccan|Cement OPC 53', 'pune', 600, 200], ['bharat|Cement OPC 53', 'jaipur', 1500, 400],
    ['volt|Copper wire 2.5mm', 'delhi', 18, 25], ['volt|Copper wire 2.5mm', 'pune', 150, 40], ['volt|LED panel 40W', 'pune', 340, 100],
    ['volt|MCB 32A', 'pune', 300, 50], ['aqua|HDPE pipe 50mm', 'pune', 600, 80]])
    await pool.execute('INSERT INTO INVENTORY(supplier_product_id, warehouse_id, quantity_on_hand, reorder_level) VALUES(?,?,?,?)', [off[o], wh[w], qty, lvl]);

  // ---- sample orders through the real transaction code
  const o1 = await svc.placeOrder(buyers[0], { items: [{ supplier_product_id: off['bharat|Steel rebar 12mm'], quantity: 10 }, { supplier_product_id: off['raj|Cement OPC 53'], quantity: 100 }] });
  await svc.payOrder(buyers[0], o1.order_id, { method: 'UPI' });
  const o2 = await svc.placeOrder(buyers[1], { items: [{ supplier_product_id: off['volt|Copper wire 2.5mm'], quantity: 6 }, { supplier_product_id: off['volt|LED panel 40W'], quantity: 80 }] });
  await svc.payOrder(buyers[1], o2.order_id, { method: 'CARD' });
  await svc.placeOrder(buyers[2], { items: [{ supplier_product_id: off['deccan|Cement OPC 53'], quantity: 150 }] });   // left unpaid
  const [ships] = await pool.query('SELECT shipment_id, order_id FROM SHIPMENT ORDER BY shipment_id');
  const s1 = ships.find(s => s.order_id === o1.order_id), s2 = ships.find(s => s.order_id === o2.order_id);
  await svc.dispatchShipment({ id: wmDelhi, role: 'WAREHOUSE_MANAGER' }, s1.shipment_id);
  await svc.deliverShipment({ id: wmDelhi, role: 'WAREHOUSE_MANAGER' }, s1.shipment_id);
  await svc.dispatchShipment({ id: wmPune, role: 'WAREHOUSE_MANAGER' }, s2.shipment_id);

  console.log('Seed complete.\n\nDemo accounts');
  console.log('  Admin              admin@procura.com        Admin@123');
  console.log('  Buyer              buyer1@skyline.com       Buyer@123');
  console.log('  Supplier           sales@bharatmetals.in    Supplier@123');
  console.log('  Warehouse manager  wm.delhi@procura.com     Warehouse@123');
  await pool.end();
})().catch(e => { console.error('db:seed failed ->', e); process.exit(1); });
