'use strict';

const { requestDb: db } = require('./logDatabases.cjs');

const PROVIDER_CONTEXT_LIMIT = 100;

const stmtByResponseId = db.prepare(`
    SELECT adapter_kind AS adapterKind, model, turns_json AS turnsJson
    FROM thought_signatures
    WHERE response_id = ?
`);
const stmtUpsert = db.prepare(`
    INSERT INTO thought_signatures
        (response_id, adapter_kind, model, created_at, turns_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(response_id) DO UPDATE SET
        adapter_kind = excluded.adapter_kind,
        model = excluded.model,
        created_at = MIN(thought_signatures.created_at, excluded.created_at),
        turns_json = excluded.turns_json
`);
const stmtTrim = db.prepare(`
    DELETE FROM thought_signatures
    WHERE response_id NOT IN (
        SELECT response_id
        FROM thought_signatures
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
    )
`);
const stmtQuery = db.prepare(`
    SELECT response_id AS responseId, adapter_kind AS adapterKind, model, turns_json AS turnsJson
    FROM thought_signatures
    WHERE response_id IN (SELECT value FROM json_each(?))
        AND adapter_kind = ?
        AND model = ?
`);
const writeProviderContext = db.transaction((responseId, jobId, adapterKind, model, context, timestamp) => {
    const existing = stmtByResponseId.get(responseId);
    let turns = [];
    if (existing?.adapterKind === adapterKind && existing.model === model) {
        turns = JSON.parse(existing.turnsJson);
    }

    const nextTurn = { jobId, createdAt: timestamp, context };
    const sameJobIndex = turns.findIndex(turn => turn.jobId === jobId);
    if (sameJobIndex >= 0) turns[sameJobIndex] = nextTurn;
    else turns.push(nextTurn);
    turns.sort((left, right) => left.createdAt - right.createdAt
        || (left.jobId < right.jobId ? -1 : left.jobId > right.jobId ? 1 : 0));

    stmtUpsert.run(
        responseId,
        adapterKind,
        model,
        timestamp,
        JSON.stringify(turns),
    );
    stmtTrim.run(PROVIDER_CONTEXT_LIMIT);
});

function requireIdentifier(value, name) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
        throw new TypeError(`${name} must be a string between 1 and 128 characters`);
    }
    return value;
}

function requireLabel(value, name) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${name} must be a nonempty string`);
    }
    return value;
}

function recordProviderContext({ responseId, jobId, adapterKind, model, context, createdAt }) {
    responseId = requireIdentifier(responseId, 'responseId');
    jobId = requireIdentifier(jobId, 'jobId');
    adapterKind = requireLabel(adapterKind, 'adapterKind');
    model = requireLabel(model, 'model');

    const timestamp = Number.isFinite(createdAt) ? Math.round(createdAt) : Date.now();
    writeProviderContext.immediate(
        responseId,
        jobId,
        adapterKind,
        model,
        context,
        timestamp,
    );
}

function queryProviderContexts(responseIds, adapterKind, model) {
    if (!Array.isArray(responseIds)) return [];
    adapterKind = requireLabel(adapterKind, 'adapterKind');
    model = requireLabel(model, 'model');

    const ids = [...new Set(responseIds.filter(id =>
        typeof id === 'string' && id.length >= 1 && id.length <= 128))];
    if (ids.length === 0) return [];

    const rows = stmtQuery.all(JSON.stringify(ids), adapterKind, model);
    const rowsById = new Map(rows.map(row => {
        const turns = JSON.parse(row.turnsJson).map(turn => turn.context);
        return [row.responseId, {
            responseId: row.responseId,
            adapterKind: row.adapterKind,
            model: row.model,
            turns,
        }];
    }));

    return ids.map(id => rowsById.get(id)).filter(Boolean);
}

module.exports = {
    recordProviderContext,
    queryProviderContexts,
};
