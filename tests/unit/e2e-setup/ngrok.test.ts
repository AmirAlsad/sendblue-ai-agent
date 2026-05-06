import { describe, expect, it } from 'vitest';
import { parseNgrokPublicUrl } from '../../../scripts/e2e/lib/ngrok.js';

describe('ngrok helpers', () => {
  it('extracts the HTTPS public URL from the local API payload', () => {
    expect(
      parseNgrokPublicUrl({
        tunnels: [
          { public_url: 'http://abc.ngrok-free.app', proto: 'http' },
          { public_url: 'https://abc.ngrok-free.app', proto: 'https' }
        ]
      })
    ).toBe('https://abc.ngrok-free.app');
  });

  it('returns undefined when no HTTPS tunnel is available', () => {
    expect(parseNgrokPublicUrl({ tunnels: [] })).toBeUndefined();
  });
});
