import { describe, expect, it } from 'vitest';
import { InMemoryMetricsCollector } from '../../src/metrics/collector.js';
import { PROMETHEUS_CONTENT_TYPE, renderPrometheus } from '../../src/metrics/prometheus.js';

describe('renderPrometheus', () => {
  it('emits HELP and TYPE lines per metric', () => {
    const c = new InMemoryMetricsCollector();
    const counter = c.counter('foo_total', { help: 'count of foos', labels: ['kind'] });
    counter.inc({ kind: 'a' });

    const out = renderPrometheus(c.snapshot());
    expect(out).toContain('# HELP foo_total count of foos');
    expect(out).toContain('# TYPE foo_total counter');
    expect(out).toContain('foo_total{kind="a"} 1');
  });

  it('renders gauges with labels', () => {
    const c = new InMemoryMetricsCollector();
    const g = c.gauge('temp', { help: 'temperature', labels: ['region'] });
    g.set({ region: 'us' }, 73);

    const out = renderPrometheus(c.snapshot());
    expect(out).toContain('# TYPE temp gauge');
    expect(out).toContain('temp{region="us"} 73');
  });

  it('renders histograms with cumulative bucket counts and sum/count', () => {
    const c = new InMemoryMetricsCollector();
    const h = c.histogram('latency_seconds', { buckets: [0.1, 0.5, 1] });
    h.observe(undefined, 0.05); // bucket 0
    h.observe(undefined, 0.2); // bucket 1
    h.observe(undefined, 0.6); // bucket 2
    h.observe(undefined, 2); // overflow (counts only)

    const out = renderPrometheus(c.snapshot());
    expect(out).toContain('# TYPE latency_seconds histogram');
    // cumulative bucket counts:
    expect(out).toContain('latency_seconds_bucket{le="0.1"} 1');
    expect(out).toContain('latency_seconds_bucket{le="0.5"} 2');
    expect(out).toContain('latency_seconds_bucket{le="1"} 3');
    expect(out).toContain('latency_seconds_bucket{le="+Inf"} 4');
    expect(out).toContain('latency_seconds_count 4');
    expect(out).toMatch(/latency_seconds_sum 2\.85/);
  });

  it('escapes label values per exposition format', () => {
    const c = new InMemoryMetricsCollector();
    const counter = c.counter('foo_total', { labels: ['msg'] });
    counter.inc({ msg: 'a"b\\c\nd' });

    const out = renderPrometheus(c.snapshot());
    expect(out).toContain('foo_total{msg="a\\"b\\\\c\\nd"} 1');
  });

  it('escapes carriage returns in label values and help text', () => {
    const c = new InMemoryMetricsCollector();
    const counter = c.counter('with_help', {
      help: 'a help text\rwith carriage return',
      labels: ['v']
    });
    counter.inc({ v: 'value\rwith\rCR' });

    const out = renderPrometheus(c.snapshot());
    // No raw \r should leak into the rendered output — that would split the
    // line and corrupt the Prometheus text exposition format.
    expect(out).not.toMatch(/\r/);
    expect(out).toContain('# HELP with_help a help text\\rwith carriage return');
    expect(out).toContain('with_help{v="value\\rwith\\rCR"} 1');
  });

  it('emits a defined content-type constant', () => {
    expect(PROMETHEUS_CONTENT_TYPE).toMatch(/text\/plain/);
    expect(PROMETHEUS_CONTENT_TYPE).toMatch(/version=0\.0\.4/);
  });
});
