'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const saveDir = path.join(process.cwd(), 'save');
if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir, { recursive: true });
}

const dbPath = path.join(saveDir, 'request-logs.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

module.exports = { db, dbPath, saveDir };
