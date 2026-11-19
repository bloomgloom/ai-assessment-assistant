import assert from 'node:assert/strict';
import { SerialTaskQueue } from './serialTaskQueue';

async function run(): Promise<void> {
  const queue = new SerialTaskQueue();
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;

  const task = (name: string, fail = false) => queue.run(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push(`${name}:start`);
    await new Promise(resolve => setTimeout(resolve, 5));
    events.push(`${name}:end`);
    active -= 1;
    if (fail) throw new Error(name);
    return name;
  });

  const results = await Promise.allSettled([
    task('first'),
    task('second', true),
    task('third'),
  ]);

  assert.equal(maxActive, 1);
  assert.deepEqual(events, [
    'first:start', 'first:end',
    'second:start', 'second:end',
    'third:start', 'third:end',
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].status, 'fulfilled');
}

run().then(() => console.log('serial task queue tests passed'));
