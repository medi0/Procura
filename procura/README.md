# Procura
A database-driven B2B procurement and supplier recommendation system (DBMS mini project, NIT Delhi, team Schema Architects).

**Stack:** MySQL 8 (InnoDB) · Node.js + Express · mysql2 · bcrypt · plain HTML/CSS/JS front end.

## Run it
1. Install Node 18+ and MySQL 8.0+.
2. `npm install`
3. Copy `.env.example` to `.env` and set `DB_PASSWORD` (and a random `SESSION_SECRET`).
4. `npm run setup`  creates the `procura` database (tables, constraints, triggers, views) and loads demo data.
5. `npm start`, then open http://localhost:3000

`npm run db:init` alone rebuilds an empty database. `npm run db:seed` loads demo data into an empty one.

## Demo accounts (sign-in page has a "fill demo credentials" link)
| Role | Email | Password |
|---|---|---|
| Admin | admin@procura.com | Admin@123 |
| Buyer | buyer1@skyline.com (also buyer2@urbaninfra.com, buyer3@greengrid.com) | Buyer@123 |
| Supplier | sales@bharatmetals.in (also sales@voltline.in, sales@rajdhani.in, sales@deccansteels.in; sales@aquaflow.in starts Pending) | Supplier@123 |
| Warehouse manager | wm.delhi@procura.com (also wm.pune@procura.com) | Warehouse@123 |

Remove the demo-credential link in `public/login.html` before any real deployment.

## What each role can do
- **Admin:** verify or reject suppliers and set reliability scores; manage categories, products, warehouses (assign managers) and users; see all orders, stock, shipments, payments.
- **Buyer:** rank verified suppliers by weighted score (adjustable sliders), build a multi-item order, place it, pay (simulated, including failures and retries), cancel with refund, track shipments by tracking number.
- **Supplier:** see verification status, publish and edit offers, see own stock and the order lines for own offers, restocking list.
- **Warehouse manager:** receive stock, see low-stock alerts, dispatch and deliver shipments for own warehouses only.

## Where each DBMS feature lives
| Feature | Where |
|---|---|
| EER to tables, keys, weak entity, ISA, multivalued attribute | `db/schema.sql` |
| Derived attributes | `available_quantity`, `line_total` (generated columns), `v_order_totals` (view) |
| CHECK constraints | `chk_inv_reserved`, price/quantity/score/lat-long ranges |
| Triggers | role checks on BUYER / SUPPLIER / ADMIN / WAREHOUSE_MANAGER / WAREHOUSE.manager_id, `trg_price_locked` |
| External schemas (views) | `v_buyer_*`, `v_supplier_*`, `v_warehouse_*` in `db/schema.sql`; the API reads them filtered by the signed-in user |
| View-only DB accounts | `db/grants.sql` (optional) |
| Ordering transaction, row locks, ascending lock order, deadlock retry | `placeOrder` and `withTx` in `src/orders.js` |
| Weighted ranking (CTE + window functions) | `src/ranking.js` |
| Security | bcrypt salted hashes, parameterised queries, session cookie (httpOnly), role middleware |

## Demonstrate the double-promised stock case
Seed data leaves Rajdhani Cements with 22 tonnes of steel rebar at Delhi Hub.
- **In the app:** sign in as two buyers in two browsers, add 15 tonnes to each cart, press Place order at the same moment. One order succeeds; the other is rolled back and offers the next-ranked supplier.
- **In MySQL Workbench (two sessions):**
```sql
-- session A                                  -- session B
START TRANSACTION;
SELECT * FROM INVENTORY WHERE inventory_id=3 FOR UPDATE;
                                              START TRANSACTION;
                                              SELECT * FROM INVENTORY WHERE inventory_id=3 FOR UPDATE;  -- waits
UPDATE INVENTORY SET reserved_quantity=reserved_quantity+15 WHERE inventory_id=3;
COMMIT;                                       -- B now reads available = 7 and must refuse a 15
```

## Scope notes
Payment is simulated (no gateway). Shipment tracking is status based. Ranking uses SQL weights, not machine learning. The role-per-API design runs all queries through one MySQL connection; `db/grants.sql` shows the matching view-only DB accounts if you want to enforce roles at the database level too.
