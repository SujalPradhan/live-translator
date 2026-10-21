import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const environment = { ...process.env };
// Some coding hosts launch their terminals with this flag. It must not turn
// the desktop application into a plain Node process.
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [fileURLToPath(new URL('../', import.meta.url)), ...process.argv.slice(2)], {
  env: environment, stdio: 'inherit'
});
child.on('exit', code => { process.exitCode = code || 0; });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
process.once('SIGTERM', () => child.kill('SIGTERM'));
process.once('SIGINT', () => child.kill('SIGINT'));
