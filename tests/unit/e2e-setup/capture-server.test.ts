import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSendblueCaptureApp } from '../../../scripts/e2e/lib/capture-server.js';
import { CAPTURE_MANAGED_WEBHOOK_TYPES, sendblueWebhookPath } from '../../../src/sendblue/webhook-types.js';
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
      sequence: 1,
      body: { message_handle: 'recv-capture-001', content: 'redacted' }
    });
    expect(capture.envelopes[0].headers['x-sendblue-webhook-secret']).toBe('redacted-test-secret');

    const saved = JSON.parse(
      await readFile(
        join(
          outputDir,
          `${capture.envelopes[0].receivedAt.replaceAll(/[:.]/g, '-')}-0001-webhook-receive.json`
        ),
        'utf8'
      )
    ) as unknown;
    expect(saved).toMatchObject(capture.envelopes[0]);
  });

  it('annotates guided captures with scenario metadata', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'sendblue-captures-'));
    tempDirs.push(outputDir);

    const capture = await createSendblueCaptureApp(outputDir, {
      metadata: () => ({
        sessionId: 'session-1',
        scenarioId: 'tapback-heart',
        scenarioTitle: 'Tapback heart'
      })
    });

    await dispatch(capture.app, {
      method: 'POST',
      path: '/webhook/receive',
      body: { message_handle: 'recv-guided-001', content: 'redacted' }
    });

    expect(capture.envelopes[0].capture).toEqual({
      sessionId: 'session-1',
      scenarioId: 'tapback-heart',
      scenarioTitle: 'Tapback heart'
    });
    expect(capture.envelopes[0].sequence).toBe(1);

    const savedFiles = await readdir(outputDir);
    expect(savedFiles[0]).toContain('0001-tapback-heart-webhook-receive.json');
  });

  it('captures every Sendblue webhook target path', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'sendblue-captures-'));
    tempDirs.push(outputDir);

    const capture = await createSendblueCaptureApp(outputDir);

    for (const type of CAPTURE_MANAGED_WEBHOOK_TYPES) {
      const response = await dispatch(capture.app, {
        method: 'POST',
        path: sendblueWebhookPath(type),
        body: { event_type: type, message_handle: `handle-${type}` }
      });

      expect(response.status, type).toBe(202);
    }

    expect(capture.envelopes.map(envelope => envelope.path)).toEqual(
      CAPTURE_MANAGED_WEBHOOK_TYPES.map(sendblueWebhookPath)
    );
  });
});
