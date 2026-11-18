'use strict';

const path = require('path');
const { existsSync, readFileSync, writeFileSync } = require('fs');

function createPrivacyGuard({ savePath }) {
    const statePath = path.join(savePath, '__privacy_guard');
    let enabled = existsSync(statePath) && readFileSync(statePath, 'utf-8').trim() === '1';

    function isEnabled() {
        return enabled;
    }

    /** Persists before switching, so a failed write leaves the mode as it was. Returns whether it changed. */
    function setEnabled(value) {
        if (value === enabled) return false;
        writeFileSync(statePath, value ? '1' : '0', 'utf-8');
        enabled = value;
        return true;
    }

    return { isEnabled, setEnabled };
}

module.exports = { createPrivacyGuard };
