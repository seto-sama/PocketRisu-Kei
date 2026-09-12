'use strict';

const { DatabaseSync } = require('node:sqlite');

let savepointSequence = 0;

function normalizeBlob(value) {
    if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    return value;
}

function normalizeRow(row) {
    if (!row || typeof row !== 'object') return row;
    for (const key of Object.keys(row)) row[key] = normalizeBlob(row[key]);
    return row;
}

function normalizeError(error) {
    if (
        error?.code === 'ERR_SQLITE_ERROR'
        && (error.errcode === 2067 || /^UNIQUE constraint failed:/i.test(error.message))
    ) {
        error.nodeCode = error.code;
        error.code = 'SQLITE_CONSTRAINT_UNIQUE';
    }
    return error;
}

function executeStatement(callback) {
    try {
        return callback();
    } catch (error) {
        throw normalizeError(error);
    }
}

function wrapStatement(statement) {
    statement.setAllowBareNamedParameters(true);
    statement.setAllowUnknownNamedParameters(true);
    return new Proxy(statement, {
        get(target, property) {
            if (property === 'get') {
                return (...args) => executeStatement(() => normalizeRow(target.get(...args)));
            }
            if (property === 'all') {
                return (...args) => executeStatement(() => target.all(...args).map(normalizeRow));
            }
            if (property === 'iterate') {
                return function* (...args) {
                    try {
                        for (const row of target.iterate(...args)) yield normalizeRow(row);
                    } catch (error) {
                        throw normalizeError(error);
                    }
                };
            }
            if (property === 'run') {
                return (...args) => executeStatement(() => target.run(...args));
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

function rollback(db, savepoint) {
    if (savepoint) {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
    } else if (db.isTransaction) {
        db.exec('ROLLBACK');
    }
}

class Database extends DatabaseSync {
    prepare(sql, options) {
        return wrapStatement(super.prepare(sql, options));
    }

    pragma(source, options = {}) {
        const statement = this.prepare(`PRAGMA ${source}`);
        try {
            const rows = statement.all();
            if (!options.simple) return rows;
            if (rows.length === 0) return undefined;
            return Object.values(rows[0])[0];
        } finally {
            if (typeof statement.close === 'function') statement.close();
            else statement[Symbol.dispose]?.();
        }
    }

    transaction(fn) {
        if (typeof fn !== 'function') throw new TypeError('Expected transaction callback to be a function');

        const createTransaction = mode => {
            const db = this;
            return function transaction(...args) {
                const savepoint = db.isTransaction
                    ? `pocketrisu_${++savepointSequence}`
                    : null;

                if (savepoint) db.exec(`SAVEPOINT ${savepoint}`);
                else db.exec(`BEGIN ${mode}`);

                try {
                    const result = Reflect.apply(fn, this, args);
                    if (result && typeof result.then === 'function') {
                        throw new TypeError('SQLite transactions must be synchronous');
                    }
                    if (savepoint) db.exec(`RELEASE ${savepoint}`);
                    else db.exec('COMMIT');
                    return result;
                } catch (error) {
                    try {
                        rollback(db, savepoint);
                    } catch {}
                    throw error;
                }
            };
        };

        const deferred = createTransaction('DEFERRED');
        deferred.deferred = deferred;
        deferred.immediate = createTransaction('IMMEDIATE');
        deferred.exclusive = createTransaction('EXCLUSIVE');
        return deferred;
    }
}

module.exports = Database;
