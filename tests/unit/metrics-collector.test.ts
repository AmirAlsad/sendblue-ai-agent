import { describe, expect, it } from 'vitest';
import {
  InMemoryMetricsCollector,
  NoopMetricsCollector,
  OVERFLOW_LABEL_VALUE
} from '../../src/metrics/collector.js';

describe('InMemoryMetricsCollector', () => {
  describe('counter', () => {
    it('accumulates values per label combination', () => {
      const c = new InMemoryMetricsCollector();
      const counter = c.counter('foo_total', { labels: ['a', 'b'] });
      counter.inc({ a: '1', b: 'x' });
      counter.inc({ a: '1', b: 'x' }, 3);
      counter.inc({ a: '2', b: 'x' });

      const snap = c.snapshot();
      expect(snap.metrics).toHaveLength(1);
      const metric = snap.metrics[0];
      expect(metric.kind).toBe('counter');
      expect(metric.series).toHaveLength(2);
      const ax1 = metric.series.find(s => s.labels.a === '1');
      expect(ax1).toBeDefined();
      // counter snapshot series have a `value` field
      expect((ax1 as { value: number }).value).toBe(4);
    });

    it('ignores negative deltas', () => {
      const c = new InMemoryMetricsCollector();
      const counter = c.counter('foo_total');
      counter.inc(undefined, 5);
      counter.inc(undefined, -3);
      const snap = c.snapshot().metrics[0];
      expect((snap.series[0] as { value: number }).value).toBe(5);
    });

    it('returns the same instance on re-registration', () => {
      const c = new InMemoryMetricsCollector();
      const a = c.counter('foo_total');
      const b = c.counter('foo_total');
      expect(a).toBe(b);
    });

    it('throws on type mismatch with same name', () => {
      const c = new InMemoryMetricsCollector();
      c.counter('shared_metric');
      expect(() => c.gauge('shared_metric')).toThrow(/already registered as counter/);
    });
  });

  describe('gauge', () => {
    it('set replaces value, inc/dec are deltas', () => {
      const c = new InMemoryMetricsCollector();
      const g = c.gauge('temp', { labels: ['region'] });
      g.set({ region: 'us' }, 70);
      g.inc({ region: 'us' }, 5);
      g.dec({ region: 'us' }, 2);
      const snap = c.snapshot().metrics[0];
      expect((snap.series[0] as { value: number }).value).toBe(73);
    });
  });

  describe('histogram', () => {
    it('places observations into the smallest bucket >= value', () => {
      const c = new InMemoryMetricsCollector();
      const h = c.histogram('latency_seconds', { buckets: [0.1, 0.5, 1] });
      h.observe(undefined, 0.05); // bucket[0]
      h.observe(undefined, 0.2); // bucket[1]
      h.observe(undefined, 0.6); // bucket[2]
      h.observe(undefined, 5); // overflow → only count

      const snap = c.snapshot().metrics[0];
      expect(snap.kind).toBe('histogram');
      const series = (snap.series as Array<{
        bucketCounts: number[];
        sum: number;
        count: number;
      }>)[0];
      expect(series.bucketCounts).toEqual([1, 1, 1]);
      expect(series.count).toBe(4);
      expect(series.sum).toBeCloseTo(0.05 + 0.2 + 0.6 + 5, 5);
    });

    it('startTimer records elapsed seconds when invoked', async () => {
      const c = new InMemoryMetricsCollector();
      const h = c.histogram('elapsed_seconds', { buckets: [0.001, 0.05, 1] });
      const stop = h.startTimer({});
      await new Promise(resolve => setTimeout(resolve, 5));
      const elapsed = stop();
      expect(elapsed).toBeGreaterThan(0);
      const snap = c.snapshot().metrics[0];
      const series = (snap.series as Array<{ count: number; sum: number }>)[0];
      expect(series.count).toBe(1);
      expect(series.sum).toBeGreaterThan(0);
    });

    it('rejects empty bucket sets', () => {
      const c = new InMemoryMetricsCollector();
      expect(() => c.histogram('empty', { buckets: [] })).toThrow(/at least one bucket/);
    });
  });

  describe('cardinality cap', () => {
    it('folds excess label combinations into a sentinel overflow series', () => {
      const c = new InMemoryMetricsCollector({ cardinalityLimit: 2 });
      const counter = c.counter('foo_total', { labels: ['key'] });
      counter.inc({ key: 'a' });
      counter.inc({ key: 'b' });
      counter.inc({ key: 'c' });
      counter.inc({ key: 'd' });

      const snap = c.snapshot().metrics[0];
      const labels = snap.series.map(s => s.labels.key);
      expect(labels).toContain('a');
      expect(labels).toContain('b');
      expect(labels).toContain(OVERFLOW_LABEL_VALUE);
      const overflow = snap.series.find(s => s.labels.key === OVERFLOW_LABEL_VALUE);
      expect((overflow as { value: number }).value).toBe(2);
    });
  });
});

describe('NoopMetricsCollector', () => {
  it('exposes no-op handles whose calls are silent', () => {
    const c = new NoopMetricsCollector();
    const counter = c.counter('foo');
    counter.inc({ a: 'x' }, 5);
    const gauge = c.gauge('bar');
    gauge.set({}, 1);
    const histogram = c.histogram('baz');
    histogram.observe({}, 0.5);
    expect(c.snapshot().metrics).toHaveLength(0);
  });
});
