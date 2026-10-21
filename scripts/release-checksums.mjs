import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const directory = path.resolve(process.argv[2] || 'release');
const files = (await readdir(directory)).filter(name => /\.(AppImage|exe|dmg)$/.test(name)).sort();
if (!files.length) throw Error('No AppImage, EXE or DMG installers found. Build an installer first.');
for (const name of files) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path.join(directory, name))) hash.update(bytes);
  await writeFile(path.join(directory, `${name}.sha256`), `${hash.digest('hex')}  ${name}\n`);
  console.log(`Checksum written: ${name}.sha256`);
}
