-- OPTIONAL: database-level role accounts (privileges on VIEWS only, never base tables).
-- Run as MySQL root after db:init. Change the passwords first.
CREATE USER IF NOT EXISTS 'procura_buyer'@'localhost'    IDENTIFIED BY 'ChangeMe_Buyer1';
CREATE USER IF NOT EXISTS 'procura_supplier'@'localhost' IDENTIFIED BY 'ChangeMe_Supplier1';
CREATE USER IF NOT EXISTS 'procura_wm'@'localhost'       IDENTIFIED BY 'ChangeMe_Warehouse1';

GRANT SELECT ON procura.v_buyer_catalog     TO 'procura_buyer'@'localhost';
GRANT SELECT ON procura.v_buyer_orders      TO 'procura_buyer'@'localhost';
GRANT SELECT ON procura.v_buyer_order_items TO 'procura_buyer'@'localhost';
GRANT SELECT ON procura.v_buyer_shipments   TO 'procura_buyer'@'localhost';
GRANT SELECT ON procura.v_buyer_payments    TO 'procura_buyer'@'localhost';

GRANT SELECT ON procura.v_supplier_inventory TO 'procura_supplier'@'localhost';
GRANT SELECT ON procura.v_supplier_orders    TO 'procura_supplier'@'localhost';

GRANT SELECT ON procura.v_warehouse_stock     TO 'procura_wm'@'localhost';
GRANT SELECT ON procura.v_warehouse_shipments TO 'procura_wm'@'localhost';

-- Demonstration: this fails for the buyer account (no privilege on the base table)
--   mysql -u procura_buyer -p procura -e "SELECT * FROM SUPPLIER;"
