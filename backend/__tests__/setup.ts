// Test setup file
import { beforeAll, afterAll, vi } from 'vitest';

// Mock environment variables
// FIELD_ENCRYPTION_KEY_B64 is the current keyring key (lib/crypto.ts) that
// backend/encryption.ts now delegates to; keyring() throws without it
// regardless of the legacy key below. PROMPT_ENCRYPTION_KEY is kept only as
// the decrypt-only legacy entry lib/crypto.ts still checks for.
process.env.FIELD_ENCRYPTION_KEY_B64 = 'X3UloVOvGg4eb95IfTcii81eNEn+Cuj9rjQO9UGvMIw=';
process.env.PROMPT_ENCRYPTION_KEY = 'dGVzdC1rZXktZm9yLXRlc3RpbmctMTIzNDU2Nzg5MDEyMzQ1Njc4OTA='; // base64 encoded 32-byte key
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';

// Mock console methods to reduce noise in tests
const originalConsole = global.console;
global.console = {
  ...originalConsole,
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// Clean up after tests
afterAll(() => {
  global.console = originalConsole;
  vi.restoreAllMocks();
});
