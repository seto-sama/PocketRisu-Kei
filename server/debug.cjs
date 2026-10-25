'use strict';

const { spawn } = require('node:child_process');

const child = spawn(process.execPath, ['--run', process.argv[2] || 'runserver', '--', ...process.argv.slice(3)], {
    stdio: 'inherit',
    env: {
        ...process.env,
        NODE_DEBUG: [process.env.NODE_DEBUG, 'pocketrisu'].filter(Boolean).join(','),
    },
});

child.on('error', error => {
    console.error(error);
    process.exitCode = 1;
});
child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code;
});
