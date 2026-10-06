import { describe, it, expect } from 'vitest';
import { encryptPrompt, decryptPrompt, isEncryptionConfigured } from '../encryption';

// Unmocked: this is the regression test for the '@' alias bug (ENC-6).
// backend/encryption.ts imports from '@/lib/crypto' (the root frontend
// project's alias), not a backend-local path. Before the vitest.config.ts
// fix, '@' resolved to backend/ itself, backend/lib/crypto did not exist,
// and this import — untested until now, since every other suite mocks
// encryption.ts — would have failed to resolve.
describe('encryption (real @/lib/crypto import)', () => {
  it('reports itself configured when the keyring key is present', () => {
    expect(isEncryptionConfigured()).toBe(true);
  });

  it('round-trips a prompt through encryptPrompt/decryptPrompt', () => {
    const plaintext = 'A [color] balloon over [city]';

    const encrypted = encryptPrompt(plaintext);
    expect(encrypted.encryptedContent).not.toBe(plaintext);
    expect(encrypted.kid).toBeTruthy();

    const decrypted = decryptPrompt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('rejects a payload tampered after encryption', () => {
    const encrypted = encryptPrompt('secret prompt');
    const tampered = { ...encrypted, encryptedContent: encrypted.encryptedContent.slice(0, -4) + 'abcd' };

    expect(() => decryptPrompt(tampered)).toThrow();
  });
});
