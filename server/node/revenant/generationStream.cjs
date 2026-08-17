'use strict';

const { generationJournalStore } = require('./generationJournal.cjs');

const JOURNAL_TAIL_FALLBACK_MS = 1000;

function isSocketOpen(socket) {
    return socket.readyState === undefined || socket.readyState === socket.OPEN;
}

function notifyRevenantJournalWaiters(job) {
    const waiters = job.journalWaiters || [];
    job.journalWaiters = [];
    for (const wake of waiters) wake();
}

function waitForRevenantJournalEvent(job, timeoutMs = JOURNAL_TAIL_FALLBACK_MS) {
    if (job.done) return Promise.resolve();
    return new Promise((resolve) => {
        const wake = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            const waiters = job.journalWaiters || [];
            const index = waiters.indexOf(wake);
            if (index !== -1) waiters.splice(index, 1);
            resolve();
        }, timeoutMs);
        job.journalWaiters ||= [];
        job.journalWaiters.push(wake);
        if (job.done) notifyRevenantJournalWaiters(job);
    });
}

function recoveryTerminalEvent(job, event) {
    if (
        event?.type === 'error'
        && (job.rawBytes || 0) > 0
    ) {
        return {
            type: 'done',
            status: 'failed_partial',
            partial: true,
            finishReason: 'upstream_error',
        };
    }
    return event;
}

function sendRevenantJournalEvent(client, job, event) {
    const outgoing = client.journalRecoverySubscriber
        ? recoveryTerminalEvent(job, event)
        : event;
    client.send(JSON.stringify(outgoing));
}

// Replay and live delivery deliberately use the same file reader. A socket
// reads to the journal's current EOF, waits for the writer, then continues at
// the next byte offset. There is no replay-to-live handoff where bytes can be
// missed or reordered.
async function streamRevenantJournal(
    ws,
    job,
    requestedOffset,
    journalStore = generationJournalStore,
) {
    let offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
        ? requestedOffset
        : 0;
    let providerStartedSent = false;
    let headersSent = false;

    while (isSocketOpen(ws)) {
        if (!providerStartedSent && job.providerStartedAt) {
            ws.send(JSON.stringify({
                type: 'provider_started',
                startedAt: job.providerStartedAt,
            }));
            providerStartedSent = true;
        }
        if (!headersSent && job.responseStatus != null) {
            ws.send(JSON.stringify({
                type: 'upstream_headers',
                status: job.responseStatus,
                headers: job.responseHeaders || {},
            }));
            headersSent = true;
        }

        const replay = await journalStore.readChunk(job.workflowId, job.id, offset);
        if (replay.bytes.length > 0) {
            ws.send(JSON.stringify({
                type: 'chunk',
                offset: replay.offset,
                dataBase64: replay.bytes.toString('base64'),
            }));
            offset += replay.bytes.length;
            continue;
        }

        if (job.done) {
            if (job.terminalEvent) sendRevenantJournalEvent(ws, job, job.terminalEvent);
            return;
        }
        await waitForRevenantJournalEvent(job);
    }
}

module.exports = {
    notifyRevenantJournalWaiters,
    sendRevenantJournalEvent,
    streamRevenantJournal,
    waitForRevenantJournalEvent,
};
