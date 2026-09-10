import { scan, plan, execute } from '../core.mjs';
import { FakeApi, movingFiles } from '../test/fake.mjs';
const results = [];
for (const concurrency of [1, 4]) {
  const api = new FakeApi(movingFiles(24), 20), prepared = plan(await scan(api));
  const start = performance.now();
  const result = await execute(api, prepared, { concurrency, pollDelay: 0 });
  results.push({ concurrency, milliseconds: Math.round(performance.now() - start), moved: result.moved, peakWrites: api.peakWrites });
}
console.log(JSON.stringify({ scenario: '24 synthetic files, 20ms simulated API latency, no real cloud writes', results, speedup: Number((results[0].milliseconds / results[1].milliseconds).toFixed(2)) }, null, 2));
