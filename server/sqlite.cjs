'use strict';

const { DatabaseSync } = require('node:sqlite');

const SQLITE_BUSY = 5;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

let savepointSequence = 0;

// Every connection waits out short lock contention, and named-parameter
// statements accept row objects that carry more fields than they bind.
function openDatabase(location, options) {
    return new DatabaseSync(location, { timeout: 5000, allowUnknownNamedParameters: true, ...options });
}

// Runs fn inside a transaction, or inside a savepoint when one is already open.
function withTransaction(db, fn, mode = 'DEFERRED') {
    const savepoint = db.isTransaction ? `tx_${++savepointSequence}` : null;
    db.exec(savepoint ? `SAVEPOINT ${savepoint}` : `BEGIN ${mode}`);
    try {
        const result = fn();
        if (typeof result?.then === 'function') throw new TypeError('SQLite transactions must be synchronous');
        db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
        return result;
    } catch (error) {
        try {
            if (savepoint) db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
            else if (db.isTransaction) db.exec('ROLLBACK');
        } catch {}
        throw error;
    }
}

// node:sqlite returns BLOBs as Uint8Array; wrap without copying where callers need Buffer APIs.
function toBuffer(value) {
    return value instanceof Uint8Array && !Buffer.isBuffer(value)
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : value;
}

function isBusyError(error) {
    return error?.code === 'ERR_SQLITE_ERROR' && (error.errcode & 0xff) === SQLITE_BUSY;
}

function isUniqueConstraintError(error) {
    return error?.code === 'ERR_SQLITE_ERROR'
        && (error.errcode === SQLITE_CONSTRAINT_UNIQUE || error.errcode === SQLITE_CONSTRAINT_PRIMARYKEY);
}

module.exports = { openDatabase, withTransaction, toBuffer, isBusyError, isUniqueConstraintError };
