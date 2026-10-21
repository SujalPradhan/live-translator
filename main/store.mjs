import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { defaults, validateSettings } from '../shared/settings.js';

export class SettingsStore {
  constructor(directory, safeStorage) {
    this.directory = directory;
    this.crypto = safeStorage;
    this.settings = { ...defaults };
    this.key = '';
    this.keyPersisted = false;
    this.notice = '';
  }
  secure() {
    return this.crypto.isEncryptionAvailable() &&
      this.crypto.getSelectedStorageBackend?.() !== 'basic_text';
  }
  async write(name, data) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, name);
    await writeFile(`${target}.tmp`, data, { mode: 0o600 });
    await rename(`${target}.tmp`, target);
  }
  async load() {
    try { this.settings = validateSettings(JSON.parse(await readFile(path.join(this.directory, 'settings.json'), 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') this.notice = 'Saved settings could not be loaded. Defaults restored.'; }
    if (this.secure()) {
      try {
        this.key = this.crypto.decryptString(await readFile(path.join(this.directory, 'credential.bin')));
        this.keyPersisted = Boolean(this.key);
      } catch (error) { if (error.code !== 'ENOENT') this.notice = 'Unlock your system keyring or enter the API key again.'; }
    }
    return this.public();
  }
  public() {
    return { settings: this.settings, hasKey: Boolean(this.key), keyPersisted: this.keyPersisted,
      secureStorage: this.secure(), notice: this.notice };
  }
  async save(input, newKey) {
    const next = validateSettings(input);
    if (newKey !== undefined && (typeof newKey !== 'string' || newKey.length > 4096)) throw Error('Invalid API key.');
    await this.write('settings.json', JSON.stringify(next, null, 2));
    this.settings = next;
    if (newKey?.trim()) {
      this.key = newKey.trim();
      this.keyPersisted = false;
      // Never persist Electron's Linux basic_text fallback.
      if (this.secure()) {
        await this.write('credential.bin', this.crypto.encryptString(this.key));
        this.keyPersisted = true;
      } else await rm(path.join(this.directory, 'credential.bin'), { force: true });
    }
    this.notice = '';
    return this.public();
  }
  async forget() {
    this.key = ''; this.keyPersisted = false;
    await rm(path.join(this.directory, 'credential.bin'), { force: true });
    return this.public();
  }
}
