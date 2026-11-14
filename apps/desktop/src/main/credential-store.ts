import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface SecureStringCipher {
  isAvailable(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<{ value: string; shouldReEncrypt: boolean }>;
}

export type TunnelCredentialErrorCode = 'credential_unreadable' | null;

export class TunnelCredentialUnreadableError extends Error {
  public constructor() {
    super('credential_unreadable');
    this.name = 'TunnelCredentialUnreadableError';
  }
}

export class TunnelCredentialStore {
  readonly #credentialPath: string;
  readonly #cipher: SecureStringCipher;
  #operationTail: Promise<void> = Promise.resolve();
  #mutationRevision = 0;
  #errorCode: TunnelCredentialErrorCode = null;

  public constructor(credentialPath: string, cipher: SecureStringCipher) {
    this.#credentialPath = credentialPath;
    this.#cipher = cipher;
  }

  public isAvailable(): Promise<boolean> {
    return this.#cipher.isAvailable();
  }

  public errorCode(): TunnelCredentialErrorCode {
    return this.#errorCode;
  }

  public async isConfigured(): Promise<boolean> {
    try {
      const metadata = await stat(this.#credentialPath);
      return metadata.isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  public async store(value: string): Promise<void> {
    if (value.length < 8 || value.length > 2048) {
      throw new Error('Tunnel runtime credential has an invalid length.');
    }
    await this.#withOperationLock(async () => {
      this.#mutationRevision += 1;
      await this.#storeUnlocked(value);
      this.#errorCode = null;
    });
  }

  public async read(): Promise<string | undefined> {
    const snapshot = await this.#withOperationLock(async () => {
      try {
        return {
          encrypted: await readFile(this.#credentialPath),
          revision: this.#mutationRevision,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { encrypted: undefined, revision: this.#mutationRevision };
        }
        throw error;
      }
    });
    if (snapshot.encrypted === undefined) {
      this.#errorCode = null;
      return undefined;
    }
    const { encrypted, revision: readRevision } = snapshot;
    let decrypted: Awaited<ReturnType<SecureStringCipher['decrypt']>>;
    try {
      decrypted = await this.#cipher.decrypt(encrypted);
    } catch {
      this.#errorCode = 'credential_unreadable';
      throw new TunnelCredentialUnreadableError();
    }
    this.#errorCode = null;
    if (decrypted.shouldReEncrypt) {
      await this.#withOperationLock(async () => {
        if (this.#mutationRevision !== readRevision) return;
        await this.#storeUnlocked(decrypted.value);
        this.#errorCode = null;
      });
    }
    return decrypted.value;
  }

  public async remove(): Promise<void> {
    await this.#withOperationLock(async () => {
      this.#mutationRevision += 1;
      await unlink(this.#credentialPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
      this.#errorCode = null;
    });
  }

  async #storeUnlocked(value: string): Promise<void> {
    if (value.length < 8 || value.length > 2048) {
      throw new Error('Tunnel runtime credential has an invalid length.');
    }
    if (!(await this.#cipher.isAvailable())) {
      throw new Error('OS-backed credential encryption is unavailable.');
    }
    const encrypted = await this.#cipher.encrypt(value);
    await mkdir(dirname(this.#credentialPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#credentialPath}.tmp`;
    await writeFile(temporaryPath, encrypted, { mode: 0o600 });
    await rename(temporaryPath, this.#credentialPath);
  }

  async #withOperationLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.#operationTail;
    let release!: () => void;
    this.#operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}
