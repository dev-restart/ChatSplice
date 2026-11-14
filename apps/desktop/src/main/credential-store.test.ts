import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SecureStringCipher } from './credential-store.js';
import { TunnelCredentialStore } from './credential-store.js';

const cipher: SecureStringCipher = {
  isAvailable: async () => true,
  encrypt: async (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
  decrypt: async (value) => ({
    value: value.toString('utf8').replace(/^encrypted:/, ''),
    shouldReEncrypt: false,
  }),
};

describe('TunnelCredentialStore', () => {
  it('stores only ciphertext in an owner-only file', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-credential-'));
    const credentialPath = join(temporaryDirectory, 'secrets', 'tunnel.enc');
    const store = new TunnelCredentialStore(credentialPath, cipher);
    try {
      await store.store('runtime-secret-value');
      expect((await readFile(credentialPath, 'utf8')).startsWith('encrypted:')).toBe(true);
      expect(await store.read()).toBe('runtime-secret-value');
      expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('classifies ciphertext that the current OS key can no longer decrypt', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-credential-'));
    const credentialPath = join(temporaryDirectory, 'secrets', 'tunnel.enc');
    const writableStore = new TunnelCredentialStore(credentialPath, cipher);
    const unreadableStore = new TunnelCredentialStore(credentialPath, {
      ...cipher,
      decrypt: async () => {
        throw new Error('platform-specific decrypt failure');
      },
    });
    try {
      await writableStore.store('runtime-secret-value');
      const ciphertext = await readFile(credentialPath);

      await expect(unreadableStore.read()).rejects.toThrow('credential_unreadable');
      expect(unreadableStore.errorCode()).toBe('credential_unreadable');
      expect(await readFile(credentialPath)).toEqual(ciphertext);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('does not let delayed key migration overwrite a newer stored credential', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-credential-'));
    const credentialPath = join(temporaryDirectory, 'secrets', 'tunnel.enc');
    const writableStore = new TunnelCredentialStore(credentialPath, cipher);
    let decryptStarted!: () => void;
    let releaseDecrypt!: () => void;
    const decryptReady = new Promise<void>((resolve) => {
      decryptStarted = resolve;
    });
    const delayedDecrypt = new Promise<{ value: string; shouldReEncrypt: boolean }>((resolve) => {
      releaseDecrypt = () => resolve({ value: 'old-runtime-value', shouldReEncrypt: true });
    });
    const migratingStore = new TunnelCredentialStore(credentialPath, {
      ...cipher,
      decrypt: async () => {
        decryptStarted();
        return delayedDecrypt;
      },
    });
    try {
      await writableStore.store('old-runtime-value');
      const reading = migratingStore.read();
      await decryptReady;
      const replacing = migratingStore.store('new-runtime-value');
      releaseDecrypt();
      await reading;
      await replacing;
      expect(await readFile(credentialPath, 'utf8')).toBe('encrypted:new-runtime-value');
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('does not resurrect a credential removed while key migration is pending', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-credential-'));
    const credentialPath = join(temporaryDirectory, 'secrets', 'tunnel.enc');
    const writableStore = new TunnelCredentialStore(credentialPath, cipher);
    let decryptStarted!: () => void;
    let releaseDecrypt!: () => void;
    const decryptReady = new Promise<void>((resolve) => {
      decryptStarted = resolve;
    });
    const delayedDecrypt = new Promise<{ value: string; shouldReEncrypt: boolean }>((resolve) => {
      releaseDecrypt = () => resolve({ value: 'old-runtime-value', shouldReEncrypt: true });
    });
    const migratingStore = new TunnelCredentialStore(credentialPath, {
      ...cipher,
      decrypt: async () => {
        decryptStarted();
        return delayedDecrypt;
      },
    });
    try {
      await writableStore.store('old-runtime-value');
      const reading = migratingStore.read();
      await decryptReady;
      const removing = migratingStore.remove();
      releaseDecrypt();
      await reading;
      await removing;
      await expect(stat(credentialPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
