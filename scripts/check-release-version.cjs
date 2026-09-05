const assert = require('node:assert/strict');
const { version } = require('../package.json');
const metadata = require('../version.json');

assert.match(version, /^\d+\.\d+\.\d+$/, 'Expected a stable release version');
assert.equal(metadata.version, version, 'version.json must match package.json');
if (process.env.GITHUB_REF_TYPE === 'tag') {
    assert.equal(process.env.GITHUB_REF_NAME, `kei-v${version}`, 'Release tag must match package.json');
}
console.log(`Release version verified: kei-v${version}`);
