'use strict';

const { encodeJournalChunk } = require('./protocol.cjs');
const { generationJournalStore } = require('./generationJournal.cjs');

const JOURNAL_TAIL_FALLBACK_MS = 1000;

function isSocketOpen(socket) {
    return socket.readyState === socket.OPEN;
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

/**
 * Decoded events exist only for a successful chat response. For an HTTP error
 * the provider's error body is the response, so it is read from the raw
 * journal for either kind.
 */
function revenantJournalKind(job, requestedKind) {
    const status = job.responseStatus;
    return requestedKind === 'events' && status != null && (status < 200 || status >= 300)
        ? 'journal'
        : requestedKind;
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
// missed or reordered. `kind` selects the provider's raw bytes or the
// server's decoded events.
async function streamRevenantJournal(
    ws,
    job,
    requestedOffset,
    kind = 'journal',
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

        // Only an EOF read that started after completion proves nothing was
        // appended between the read and the terminal event.
        const doneBeforeRead = job.done;
        const replay = await journalStore.readChunk(
            job.workflowId,
            job.id,
            offset,
            revenantJournalKind(job, kind),
        );
        if (replay.bytes.length > 0) {
            await new Promise((resolve, reject) => {
                ws.send(encodeJournalChunk(replay.offset, replay.bytes), error => {
                    if (error) reject(error);
                    else resolve();
                });
            });
            offset += replay.bytes.length;
            continue;
        }

        if (doneBeforeRead) {
            if (job.terminalEvent) sendRevenantJournalEvent(ws, job, job.terminalEvent);
            return;
        }
        if (!job.done) await waitForRevenantJournalEvent(job);
    }
}

module.exports = {
    notifyRevenantJournalWaiters,
    revenantJournalKind,
    sendRevenantJournalEvent,
    streamRevenantJournal,
};
