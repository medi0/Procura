// Creates the database and runs db/schema.sql (understands DELIMITER blocks).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function splitSql(sql) {
  const out = []; let delim = ';'; let buf = '';
  for (const line of sql.split(/\r?\n/)) {
    const m = line.match(/^\s*DELIMITER\s+(\S+)\s*$/i);
    if (m) { delim = m[1]; continue; }
    if (!buf && (/^\s*--/.test(line) || !line.trim())) continue;   // skip comment / blank lines between statements
    buf += line + '\n';
    if (buf.trimEnd().endsWith(delim)) {
      const stmt = buf.trimEnd().slice(0, -delim.length).trim();
      if (stmt) out.push(stmt);
      buf = '';
    }
  }
  return out;
}

(async () => {
  const name = process.env.DB_NAME || 'procura';
  const cn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || ''
  });
  await cn.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await cn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
  await cn.query(`USE \`${name}\``);
  const stmts = splitSql(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  for (const s of stmts) await cn.query(s);
  console.log(`Database "${name}" created: ${stmts.length} statements executed.`);
  await cn.end();
})().catch(e => { console.error('db:init failed ->', e.message); process.exit(1); });
