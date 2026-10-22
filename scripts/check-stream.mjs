// Checks that a deployed server streams events as they happen instead of holding them back in a proxy buffer.
// Usage: node scripts/check-stream.mjs https://your-server.example.org [https://your-site.example.org]
// It starts a run of the demonstration project (no language model is called), reads the event stream and compares
// the time over which the events were emitted with the time over which they arrived. A buffering proxy delivers
// them together at the end.
const [base, origin] = process.argv.slice(2);
if (!base) {
  console.error('Usage: node scripts/check-stream.mjs <server address> [<site address>]');
  process.exit(2);
}
const server = base.replace(/\/+$/, '');
const headers = origin ? { origin: origin.replace(/\/+$/, '') } : {};
const results = [];
const report = (ok, label, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`);
};

console.log(`Server: ${server}. The first request may take about a minute if the service is asleep.`);
const started = await fetch(`${server}/api/projects/demo/runs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ inputs: { topic: `stream check ${Date.now()}` } }),
  signal: AbortSignal.timeout(120_000),
});
report(started.status === 202, 'a run can be started', `status ${started.status}`);
if (started.status !== 202) process.exit(1);
const { runId } = await started.json();

const stream = await fetch(`${server}/api/runs/${runId}/events`, { headers, signal: AbortSignal.timeout(60_000) });
const type = stream.headers.get('content-type') ?? '';
report(type.startsWith('text/event-stream'), 'the content type is text/event-stream', type);
report(!stream.headers.get('content-encoding'), 'the stream is not compressed', stream.headers.get('content-encoding') ?? 'none');
report(/no-transform/.test(stream.headers.get('cache-control') ?? ''), 'Cache-Control forbids transformation', stream.headers.get('cache-control') ?? '');
if (origin) {
  report(stream.headers.get('access-control-allow-origin') === headers.origin, 'CORS names the site', stream.headers.get('access-control-allow-origin') ?? 'absent');
}

const arrivals = [];
const emitted = [];
const decoder = new TextDecoder();
let buffer = '';
for await (const chunk of stream.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let end;
  while ((end = buffer.indexOf('\n\n')) >= 0) {
    const block = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    if (!block.includes('event: node')) continue;
    const data = JSON.parse(block.split('\n').find((line) => line.startsWith('data: ')).slice(6));
    arrivals.push(performance.now());
    emitted.push(data.ts);
  }
}

report(arrivals.length >= 5, 'the events were received', `${arrivals.length} events`);
const arrivedOver = arrivals.at(-1) - arrivals[0];
const emittedOver = emitted.at(-1) - emitted[0];
console.log(`      emitted over ${Math.round(emittedOver)} ms, received over ${Math.round(arrivedOver)} ms`);
report(emittedOver > 300, 'the run was slow enough to show buffering', `${Math.round(emittedOver)} ms`);
report(arrivedOver >= emittedOver * 0.7, 'the events arrived as they were emitted, not together at the end');
process.exit(results.every(Boolean) ? 0 : 1);
