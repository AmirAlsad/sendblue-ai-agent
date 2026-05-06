import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSendblueCaptureApp } from '../../../scripts/e2e/lib/capture-server.js';
import { dispatch } from '../../helpers/dispatch.js';

describe('Sendblue fixture capture server', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map(path => rm(path, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('captures request envelopes with headers, body, timestamp, and path', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'sendblue-captures-'));
    tempDirs.push(outputDir);

    const capture = await createSendblueCaptureApp(outputDir);
    const response = await dispatch(capture.app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { 'x-sendblue-webhook-secret': 'redacted-test-secret' },
      body: { message_handle: 'recv-capture-001', content: 'redacted' }
    });

    expect(response.status).toBe(202);
    expect(capture.envelopes).toHaveLength(1);
    expect(capture.envelopes[0]).toMatchObject({
      path: '/webhook/receive',
      body: { message_handle: 'recv-capture-001', content: 'redacted' }
    });
    expect(capture.envelopes[0].headers['x-sendblue-webhook-secret']).toBe('redacted-test-secret');

    const saved = JSON.parse(
      await readFile(
        join(
          outputDir,
          `${capture.envelopes[0].receivedAt.replaceAll(/[:.]/g, '-')}-webhook-receive.json`
        ),
        'utf8'
      )
    ) as unknown;
    expect(saved).toMatchObject(capture.envelopes[0]);
  });
});
