// Weighted supplier ranking - plain SQL (CTE + window functions), no machine learning.
// Each factor is min-max normalised to 0..1 across the candidate suppliers, then
// combined with adjustable weights. Only VERIFIED, active suppliers with enough stock qualify.
const pool = require('./db');

const DEFAULT_W = { price: 30, avail: 15, dist: 15, lead: 15, rel: 25 };

function normaliseWeights(w = {}) {
  const x = {};
  let sum = 0;
  for (const k of Object.keys(DEFAULT_W)) {
    const v = Number(w[k]);
    x[k] = Number.isFinite(v) && v >= 0 ? v : DEFAULT_W[k];
    sum += x[k];
  }
  if (sum === 0) return normaliseWeights({});
  for (const k of Object.keys(x)) x[k] /= sum;
  return x;
}

const SQL = `
WITH cand AS (
  SELECT sp.supplier_product_id, s.user_id AS supplier_id, s.business_name, s.city, s.reliability_score,
         sp.unit_price, sp.lead_time_days, sp.min_order_qty,
         COALESCE(SUM(i.available_quantity), 0) AS available,
         ROUND(ST_Distance_Sphere(POINT(s.longitude, s.latitude), POINT(?, ?)) / 1000, 1) AS distance_km
  FROM SUPPLIER_PRODUCT sp
  JOIN SUPPLIER s ON s.user_id = sp.supplier_id AND s.verification_status = 'VERIFIED'
  JOIN USERS u    ON u.user_id = s.user_id AND u.is_active = TRUE
  LEFT JOIN INVENTORY i ON i.supplier_product_id = sp.supplier_product_id
  WHERE sp.product_id = ? AND sp.is_active = TRUE AND sp.min_order_qty <= ? AND s.user_id <> ?
  GROUP BY sp.supplier_product_id, s.user_id, s.business_name, s.city, s.reliability_score,
           s.longitude, s.latitude, sp.unit_price, sp.lead_time_days, sp.min_order_qty
  HAVING available >= ?
), n AS (
  SELECT cand.*,
    (MAX(unit_price)  OVER () - unit_price)  / NULLIF(MAX(unit_price)  OVER () - MIN(unit_price)  OVER (), 0) AS price_n,
    (available - MIN(available) OVER ())     / NULLIF(MAX(available)   OVER () - MIN(available)   OVER (), 0) AS avail_n,
    (MAX(distance_km) OVER () - distance_km) / NULLIF(MAX(distance_km) OVER () - MIN(distance_km) OVER (), 0) AS dist_n,
    (MAX(lead_time_days) OVER () - lead_time_days) / NULLIF(MAX(lead_time_days) OVER () - MIN(lead_time_days) OVER (), 0) AS lead_n,
    reliability_score / 100 AS rel_n
  FROM cand
)
SELECT supplier_product_id, supplier_id, business_name, city, reliability_score, unit_price, lead_time_days,
       min_order_qty, available, distance_km,
       ROUND(100 * (? * COALESCE(price_n, 1) + ? * COALESCE(avail_n, 1) + ? * COALESCE(dist_n, 1)
                  + ? * COALESCE(lead_n, 1)  + ? * rel_n), 1) AS score
FROM n
ORDER BY score DESC, unit_price ASC`;

async function rank({ productId, quantity, lat, lng, weights, excludeSupplier = 0 }) {
  const w = normaliseWeights(weights);
  const [rows] = await pool.query(SQL, [lng, lat, productId, quantity, excludeSupplier, quantity,
                                        w.price, w.avail, w.dist, w.lead, w.rel]);
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

module.exports = { rank, DEFAULT_W };
