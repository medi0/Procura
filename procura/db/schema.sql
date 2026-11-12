-- =====================================================================
--  PROCURA  -  B2B procurement & supplier recommendation system
--  MySQL 8.0+ (InnoDB).  Tables, constraints, triggers and views.
--  Run with:  npm run db:init   (or paste into MySQL Workbench after
--  CREATE DATABASE procura; USE procura;)
-- =====================================================================

-- ---------- 1. USER HIERARCHY (USERS + 4 subclasses + multivalued phone) ----------
CREATE TABLE USERS (
  user_id       INT AUTO_INCREMENT PRIMARY KEY,
  full_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  role          ENUM('ADMIN','BUYER','SUPPLIER','WAREHOUSE_MANAGER') NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE USER_PHONE (
  user_id INT NOT NULL,
  phone   VARCHAR(20) NOT NULL,
  PRIMARY KEY (user_id, phone),
  FOREIGN KEY (user_id) REFERENCES USERS(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE ADMIN (
  user_id     INT PRIMARY KEY,
  designation VARCHAR(80),
  FOREIGN KEY (user_id) REFERENCES USERS(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE BUYER (
  user_id      INT PRIMARY KEY,
  company_name VARCHAR(120) NOT NULL,
  address      VARCHAR(255) NOT NULL,
  city         VARCHAR(60)  NOT NULL,
  latitude     DECIMAL(9,6) NOT NULL,
  longitude    DECIMAL(9,6) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES USERS(user_id) ON DELETE CASCADE,
  CONSTRAINT chk_buyer_lat CHECK (latitude  BETWEEN -90  AND 90),
  CONSTRAINT chk_buyer_lng CHECK (longitude BETWEEN -180 AND 180)
) ENGINE=InnoDB;

CREATE TABLE SUPPLIER (
  user_id             INT PRIMARY KEY,
  business_name       VARCHAR(120) NOT NULL,
  address             VARCHAR(255) NOT NULL,
  city                VARCHAR(60)  NOT NULL,
  latitude            DECIMAL(9,6) NOT NULL,
  longitude           DECIMAL(9,6) NOT NULL,
  verification_status ENUM('PENDING','VERIFIED','REJECTED') NOT NULL DEFAULT 'PENDING',
  reliability_score   DECIMAL(5,2) NOT NULL DEFAULT 50,
  FOREIGN KEY (user_id) REFERENCES USERS(user_id) ON DELETE CASCADE,
  CONSTRAINT chk_sup_lat CHECK (latitude  BETWEEN -90  AND 90),
  CONSTRAINT chk_sup_lng CHECK (longitude BETWEEN -180 AND 180),
  CONSTRAINT chk_sup_rel CHECK (reliability_score BETWEEN 0 AND 100)
) ENGINE=InnoDB;

CREATE TABLE WAREHOUSE_MANAGER (
  user_id       INT PRIMARY KEY,
  employee_code VARCHAR(20) NOT NULL UNIQUE,
  hire_date     DATE,
  FOREIGN KEY (user_id) REFERENCES USERS(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------- 2. CATALOGUE ----------
CREATE TABLE CATEGORY (
  category_id   INT AUTO_INCREMENT PRIMARY KEY,
  category_name VARCHAR(80) NOT NULL UNIQUE,
  description   VARCHAR(255)
) ENGINE=InnoDB;

CREATE TABLE PRODUCT (
  product_id   INT AUTO_INCREMENT PRIMARY KEY,
  category_id  INT NOT NULL,
  product_name VARCHAR(120) NOT NULL,
  description  VARCHAR(255),
  unit         VARCHAR(20) NOT NULL,
  UNIQUE (category_id, product_name),
  FOREIGN KEY (category_id) REFERENCES CATEGORY(category_id)
) ENGINE=InnoDB;

CREATE TABLE SUPPLIER_PRODUCT (
  supplier_product_id INT AUTO_INCREMENT PRIMARY KEY,
  supplier_id         INT NOT NULL,
  product_id          INT NOT NULL,
  unit_price          DECIMAL(12,2) NOT NULL,
  min_order_qty       INT NOT NULL DEFAULT 1,
  lead_time_days      INT NOT NULL DEFAULT 3,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (supplier_id, product_id),
  FOREIGN KEY (supplier_id) REFERENCES SUPPLIER(user_id),
  FOREIGN KEY (product_id)  REFERENCES PRODUCT(product_id),
  CONSTRAINT chk_sp_price CHECK (unit_price > 0),
  CONSTRAINT chk_sp_moq   CHECK (min_order_qty > 0),
  CONSTRAINT chk_sp_lead  CHECK (lead_time_days >= 0)
) ENGINE=InnoDB;

-- ---------- 3. WAREHOUSES & INVENTORY ----------
CREATE TABLE WAREHOUSE (
  warehouse_id   INT AUTO_INCREMENT PRIMARY KEY,
  warehouse_name VARCHAR(80) NOT NULL,
  address        VARCHAR(255),
  city           VARCHAR(60) NOT NULL,
  manager_id     INT NULL,
  FOREIGN KEY (manager_id) REFERENCES USERS(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE INVENTORY (
  inventory_id        INT AUTO_INCREMENT PRIMARY KEY,
  supplier_product_id INT NOT NULL,
  warehouse_id        INT NOT NULL,
  quantity_on_hand    INT NOT NULL DEFAULT 0,
  reserved_quantity   INT NOT NULL DEFAULT 0,
  reorder_level       INT NOT NULL DEFAULT 0,
  last_updated        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  available_quantity  INT GENERATED ALWAYS AS (quantity_on_hand - reserved_quantity) STORED,
  UNIQUE (supplier_product_id, warehouse_id),
  FOREIGN KEY (supplier_product_id) REFERENCES SUPPLIER_PRODUCT(supplier_product_id),
  FOREIGN KEY (warehouse_id)        REFERENCES WAREHOUSE(warehouse_id),
  CONSTRAINT chk_inv_onhand   CHECK (quantity_on_hand >= 0),
  CONSTRAINT chk_inv_reserved CHECK (reserved_quantity >= 0 AND reserved_quantity <= quantity_on_hand),
  CONSTRAINT chk_inv_reorder  CHECK (reorder_level >= 0)
) ENGINE=InnoDB;

-- ---------- 4. ORDERS, ITEMS, SHIPMENTS, PAYMENTS ----------
CREATE TABLE ORDERS (
  order_id         INT AUTO_INCREMENT PRIMARY KEY,
  buyer_id         INT NOT NULL,
  order_date       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status           ENUM('PLACED','CONFIRMED','PROCESSING','SHIPPED','DELIVERED','CANCELLED') NOT NULL DEFAULT 'PLACED',
  shipping_address VARCHAR(255) NOT NULL,
  invoice_number   VARCHAR(30) NULL UNIQUE,
  FOREIGN KEY (buyer_id) REFERENCES BUYER(user_id)
) ENGINE=InnoDB;

CREATE TABLE ORDER_ITEM (
  order_id      INT NOT NULL,
  order_item_id INT NOT NULL,
  inventory_id  INT NOT NULL,
  quantity      INT NOT NULL,
  unit_price    DECIMAL(12,2) NOT NULL,
  line_total    DECIMAL(14,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  PRIMARY KEY (order_id, order_item_id),
  FOREIGN KEY (order_id)     REFERENCES ORDERS(order_id) ON DELETE CASCADE,
  FOREIGN KEY (inventory_id) REFERENCES INVENTORY(inventory_id),
  CONSTRAINT chk_oi_qty   CHECK (quantity > 0),
  CONSTRAINT chk_oi_price CHECK (unit_price > 0)
) ENGINE=InnoDB;

CREATE TABLE SHIPMENT (
  shipment_id            INT AUTO_INCREMENT PRIMARY KEY,
  order_id               INT NOT NULL,
  warehouse_id           INT NOT NULL,
  tracking_number        VARCHAR(40) NOT NULL UNIQUE,
  shipment_status        ENUM('PENDING','DISPATCHED','DELIVERED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  dispatch_date          DATE NULL,
  expected_delivery_date DATE NULL,
  delivered_date         DATE NULL,
  UNIQUE (order_id, warehouse_id),
  FOREIGN KEY (order_id)     REFERENCES ORDERS(order_id) ON DELETE CASCADE,
  FOREIGN KEY (warehouse_id) REFERENCES WAREHOUSE(warehouse_id)
) ENGINE=InnoDB;

CREATE TABLE PAYMENT (
  payment_id      INT AUTO_INCREMENT PRIMARY KEY,
  order_id        INT NOT NULL,
  amount          DECIMAL(14,2) NOT NULL,
  payment_method  ENUM('UPI','CARD','NETBANKING','BANK_TRANSFER') NOT NULL DEFAULT 'UPI',
  payment_status  ENUM('PENDING','COMPLETED','FAILED','REFUNDED') NOT NULL DEFAULT 'PENDING',
  transaction_ref VARCHAR(40) NOT NULL UNIQUE,
  payment_date    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES ORDERS(order_id) ON DELETE CASCADE,
  CONSTRAINT chk_pay_amount CHECK (amount > 0)
) ENGINE=InnoDB;

CREATE INDEX idx_inv_wh      ON INVENTORY(warehouse_id);
CREATE INDEX idx_order_buyer ON ORDERS(buyer_id);
CREATE INDEX idx_item_inv    ON ORDER_ITEM(inventory_id);
CREATE INDEX idx_pay_order   ON PAYMENT(order_id);

-- ---------- 5. TRIGGERS (rules the ER diagram cannot express) ----------
DELIMITER $$

CREATE TRIGGER trg_buyer_role BEFORE INSERT ON BUYER FOR EACH ROW
BEGIN
  IF (SELECT role FROM USERS WHERE user_id = NEW.user_id) <> 'BUYER' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'User does not have the BUYER role';
  END IF;
END$$

CREATE TRIGGER trg_supplier_role BEFORE INSERT ON SUPPLIER FOR EACH ROW
BEGIN
  IF (SELECT role FROM USERS WHERE user_id = NEW.user_id) <> 'SUPPLIER' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'User does not have the SUPPLIER role';
  END IF;
END$$

CREATE TRIGGER trg_admin_role BEFORE INSERT ON ADMIN FOR EACH ROW
BEGIN
  IF (SELECT role FROM USERS WHERE user_id = NEW.user_id) <> 'ADMIN' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'User does not have the ADMIN role';
  END IF;
END$$

CREATE TRIGGER trg_wm_role BEFORE INSERT ON WAREHOUSE_MANAGER FOR EACH ROW
BEGIN
  IF (SELECT role FROM USERS WHERE user_id = NEW.user_id) <> 'WAREHOUSE_MANAGER' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'User does not have the WAREHOUSE_MANAGER role';
  END IF;
END$$

CREATE TRIGGER trg_warehouse_mgr_ins BEFORE INSERT ON WAREHOUSE FOR EACH ROW
BEGIN
  IF NEW.manager_id IS NOT NULL AND
     (SELECT role FROM USERS WHERE user_id = NEW.manager_id) <> 'WAREHOUSE_MANAGER' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only a WAREHOUSE_MANAGER can manage a warehouse';
  END IF;
END$$

CREATE TRIGGER trg_warehouse_mgr_upd BEFORE UPDATE ON WAREHOUSE FOR EACH ROW
BEGIN
  IF NEW.manager_id IS NOT NULL AND
     (SELECT role FROM USERS WHERE user_id = NEW.manager_id) <> 'WAREHOUSE_MANAGER' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only a WAREHOUSE_MANAGER can manage a warehouse';
  END IF;
END$$

CREATE TRIGGER trg_price_locked BEFORE UPDATE ON ORDER_ITEM FOR EACH ROW
BEGIN
  IF NEW.unit_price <> OLD.unit_price THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Order item price is locked at the time of purchase';
  END IF;
END$$

DELIMITER ;

-- ---------- 6. VIEWS (external schemas) ----------
CREATE VIEW v_order_totals AS
SELECT order_id, SUM(line_total) AS total_amount
FROM ORDER_ITEM GROUP BY order_id;

-- Buyer ---------------------------------------------------------------
CREATE VIEW v_buyer_catalog AS
SELECT sp.supplier_product_id, p.product_id, p.product_name, c.category_name, p.unit,
       s.business_name AS supplier_name, s.city AS supplier_city,
       sp.unit_price, sp.min_order_qty, sp.lead_time_days,
       COALESCE(SUM(i.available_quantity), 0) AS total_available
FROM SUPPLIER_PRODUCT sp
JOIN PRODUCT  p ON p.product_id  = sp.product_id
JOIN CATEGORY c ON c.category_id = p.category_id
JOIN SUPPLIER s ON s.user_id = sp.supplier_id AND s.verification_status = 'VERIFIED'
LEFT JOIN INVENTORY i ON i.supplier_product_id = sp.supplier_product_id
WHERE sp.is_active = TRUE
GROUP BY sp.supplier_product_id, p.product_id, p.product_name, c.category_name, p.unit,
         s.business_name, s.city, sp.unit_price, sp.min_order_qty, sp.lead_time_days;

CREATE VIEW v_buyer_orders AS
SELECT o.order_id, o.buyer_id, o.order_date, o.status, o.shipping_address, o.invoice_number,
       COALESCE(t.total_amount, 0) AS total_amount,
       (SELECT p.payment_status FROM PAYMENT p WHERE p.order_id = o.order_id
         ORDER BY p.payment_id DESC LIMIT 1) AS payment_status
FROM ORDERS o LEFT JOIN v_order_totals t ON t.order_id = o.order_id;

CREATE VIEW v_buyer_order_items AS
SELECT oi.order_id, o.buyer_id, oi.order_item_id, p.product_name, p.unit, s.business_name AS supplier_name,
       w.city AS warehouse_city, oi.quantity, oi.unit_price, oi.line_total
FROM ORDER_ITEM oi
JOIN ORDERS o            ON o.order_id = oi.order_id
JOIN INVENTORY i         ON i.inventory_id = oi.inventory_id
JOIN WAREHOUSE w         ON w.warehouse_id = i.warehouse_id
JOIN SUPPLIER_PRODUCT sp ON sp.supplier_product_id = i.supplier_product_id
JOIN PRODUCT p           ON p.product_id = sp.product_id
JOIN SUPPLIER s          ON s.user_id = sp.supplier_id;

CREATE VIEW v_buyer_shipments AS
SELECT sh.shipment_id, sh.order_id, o.buyer_id, o.status AS order_status, sh.tracking_number, sh.shipment_status,
       sh.dispatch_date, sh.expected_delivery_date, sh.delivered_date, w.city AS warehouse_city
FROM SHIPMENT sh JOIN ORDERS o ON o.order_id = sh.order_id JOIN WAREHOUSE w ON w.warehouse_id = sh.warehouse_id;

CREATE VIEW v_buyer_payments AS
SELECT pay.payment_id, pay.order_id, o.buyer_id, pay.amount, pay.payment_method, pay.payment_status,
       pay.transaction_ref, pay.payment_date
FROM PAYMENT pay JOIN ORDERS o ON o.order_id = pay.order_id;

-- Supplier ------------------------------------------------------------
CREATE VIEW v_supplier_inventory AS
SELECT sp.supplier_id, i.inventory_id, p.product_name, p.unit, w.warehouse_name, w.city AS warehouse_city,
       i.quantity_on_hand, i.reserved_quantity, i.available_quantity, i.reorder_level
FROM INVENTORY i
JOIN SUPPLIER_PRODUCT sp ON sp.supplier_product_id = i.supplier_product_id
JOIN PRODUCT p   ON p.product_id = sp.product_id
JOIN WAREHOUSE w ON w.warehouse_id = i.warehouse_id;

CREATE VIEW v_supplier_orders AS
SELECT sp.supplier_id, o.order_id, o.order_date, o.status, p.product_name, p.unit,
       oi.quantity, oi.unit_price, oi.line_total, b.company_name AS buyer_company, b.city AS buyer_city
FROM ORDER_ITEM oi
JOIN ORDERS o            ON o.order_id = oi.order_id
JOIN BUYER b             ON b.user_id = o.buyer_id
JOIN INVENTORY i         ON i.inventory_id = oi.inventory_id
JOIN SUPPLIER_PRODUCT sp ON sp.supplier_product_id = i.supplier_product_id
JOIN PRODUCT p           ON p.product_id = sp.product_id;

-- Warehouse manager (no prices, no payments, no buyer profiles) ---------
CREATE VIEW v_warehouse_stock AS
SELECT w.manager_id, w.warehouse_id, w.warehouse_name, w.city AS warehouse_city, i.inventory_id,
       i.supplier_product_id, p.product_name, p.unit, s.business_name AS supplier_name,
       i.quantity_on_hand, i.reserved_quantity, i.available_quantity, i.reorder_level, i.last_updated
FROM INVENTORY i
JOIN WAREHOUSE w         ON w.warehouse_id = i.warehouse_id
JOIN SUPPLIER_PRODUCT sp ON sp.supplier_product_id = i.supplier_product_id
JOIN PRODUCT p           ON p.product_id = sp.product_id
JOIN SUPPLIER s          ON s.user_id = sp.supplier_id;

CREATE VIEW v_warehouse_shipments AS
SELECT w.manager_id, sh.shipment_id, sh.order_id, o.status AS order_status, sh.tracking_number, sh.shipment_status,
       sh.dispatch_date, sh.expected_delivery_date, sh.delivered_date, w.warehouse_id, w.warehouse_name, w.city AS warehouse_city,
       (SELECT SUM(oi.quantity) FROM ORDER_ITEM oi JOIN INVENTORY i ON i.inventory_id = oi.inventory_id
         WHERE oi.order_id = sh.order_id AND i.warehouse_id = sh.warehouse_id) AS units
FROM SHIPMENT sh
JOIN WAREHOUSE w ON w.warehouse_id = sh.warehouse_id
JOIN ORDERS o    ON o.order_id = sh.order_id;
