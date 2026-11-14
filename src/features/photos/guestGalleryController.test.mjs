import assert from 'node:assert/strict';
import test from 'node:test';
import { createGuestGalleryController, GALLERY_REFRESH_MS } from './guestGalleryController.mjs';

const flush = async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); };
const photo = (number) => ({
  id: `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`,
  createdAt: new Date(Date.parse('2026-11-21T00:00:00Z') + number * 1000).toISOString(),
  mimeType: 'image/jpeg',
});
const page = (numbers, nextCursor = null) => ({ photos: numbers.map(photo), nextCursor });
const ids = (numbers) => numbers.map((number) => photo(number).id);

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    timers,
    setTimer(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    async tick(duration) {
      const end = now + duration;
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
        await flush();
      }
      now = end;
    },
  };
}

function setup(t, options = {}) {
  const clock = fakeClock();
  const calls = [];
  const updates = [];
  const controller = createGuestGalleryController({
    getPage(request) {
      return new Promise((resolve, reject) => calls.push({ ...request, resolve, reject }));
    },
    onChange: (state) => updates.push(state),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    ...options,
  });
  t.after(() => controller.dispose());
  const state = () => controller.getSnapshot();
  const complete = async (method, result) => {
    const promise = controller[method]();
    calls.at(-1).resolve(result);
    await promise;
    return state();
  };
  return { controller, clock, calls, updates, state, complete };
}

test('polling starts 30 seconds after completion and never overlaps a slow request', async (t) => {
  const { controller, clock, calls, state, complete } = setup(t);
  assert.equal(GALLERY_REFRESH_MS, 30_000);
  await complete('refresh', page([3, 2], 'older'));
  await clock.tick(29_999);
  assert.equal(calls.length, 1);
  await clock.tick(1);
  assert.equal(calls.length, 2);
  assert.equal(state().isLoading, false);
  assert.equal(state().isLoadingMore, false);
  assert.deepEqual(state().photos.map((item) => item.id), ids([3, 2]));
  await clock.tick(90_000);
  assert.equal(calls.length, 2);
  calls[1].resolve(page([4, 3], 'new-head-boundary'));
  await flush();
  assert.equal(clock.timers.size, 1);
  await clock.tick(29_999);
  assert.equal(calls.length, 2);
  await clock.tick(1);
  assert.equal(calls.length, 3);
  controller.dispose();
  assert.equal(calls[2].signal.aborted, true);
  assert.equal(clock.timers.size, 0);
});

test('automatic checks defer to pagination without aborting it or resetting older photos', async (t) => {
  const { controller, calls, state, complete } = setup(t);
  await complete('refresh', page([5, 4], 'older'));
  const more = controller.loadMore();
  assert.equal(calls[1].cursor, 'older');
  controller.check();
  controller.check();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].signal.aborted, false);
  calls[1].resolve(page([3, 2], 'oldest'));
  await more;
  assert.equal(calls.length, 3, 'Deferred checks coalesce into one head request');
  assert.equal(state().isLoadingMore, false);
  calls[2].resolve(page([6, 5], 'new-head'));
  await flush();
  assert.deepEqual(state().photos.map((item) => item.id), ids([6, 5, 4, 3, 2]));
  assert.equal(state().nextCursor, 'oldest');
});

test('upload completion immediately adds new photos without clearing the loaded older pages', async (t) => {
  const { controller, calls, state, complete } = setup(t);
  await complete('refresh', page([5, 4], 'older'));
  await complete('loadMore', page([3, 2], 'oldest'));
  const uploaded = controller.refresh({ preservePhotos: true });
  assert.equal(calls.length, 3, 'The upload triggers a request without waiting for the polling timer');
  assert.equal(state().isLoading, false);
  assert.deepEqual(state().photos.map((item) => item.id), ids([5, 4, 3, 2]));
  calls[2].resolve(page([6, 5], 'updated-head'));
  await uploaded;
  assert.deepEqual(state().photos.map((item) => item.id), ids([6, 5, 4, 3, 2]));
  assert.equal(state().nextCursor, 'oldest');
});

test('automatic updates preserve guest credits on older photos and accept refreshed credits on the head', async (t) => {
  const { state, complete } = setup(t);
  const credited = (numbers, nextCursor, name) => ({
    ...page(numbers, nextCursor), photos: numbers.map((number) => ({ ...photo(number), guestName: name })),
  });
  await complete('refresh', credited([5, 4], 'older', 'Jamie'));
  await complete('loadMore', credited([3, 2], 'oldest', 'Tess'));
  await complete('check', credited([6, 5], 'updated-head', 'Alex'));
  assert.deepEqual(state().photos.map(({ guestName }) => guestName), ['Alex', 'Alex', 'Jamie', 'Tess', 'Tess']);
  await complete('check', credited([6, 5], 'updated-head', 'Alex Rivera'));
  assert.equal(state().photos[0].guestName, 'Alex Rivera');
  assert.equal(state().photos.at(-1).guestName, 'Tess');
  assert.equal(state().nextCursor, 'oldest');
});

test('uploads completed during pagination queue a single update and leave the active request running', async (t) => {
  const { controller, calls, state, complete } = setup(t);
  await complete('refresh', page([5, 4], 'older'));
  const more = controller.loadMore();
  controller.refresh({ preservePhotos: true });
  controller.refresh({ preservePhotos: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].signal.aborted, false);
  calls[1].resolve(page([3, 2], 'oldest'));
  await more;
  assert.equal(calls.length, 3);
  calls[2].resolve(page([7, 6, 5], 'updated-head'));
  await flush();
  assert.deepEqual(state().photos.map((item) => item.id), ids([7, 6, 5, 4, 3, 2]));
  assert.equal(state().nextCursor, 'oldest');
});

test('automatic recovery after an initial failure initializes pagination and permits older memories', async (t) => {
  const { controller, clock, calls, state, complete } = setup(t);
  const initial = controller.refresh();
  calls[0].reject(Object.assign(new Error('The gallery is temporarily unavailable.'), { status: 503 }));
  await initial;
  assert.equal(state().photos.length, 0);
  assert.match(state().error, /temporarily unavailable/);
  await clock.tick(30_000);
  calls[1].resolve(page([4, 3], 'recovered-tail'));
  await flush();
  assert.equal(state().error, '');
  assert.equal(state().nextCursor, 'recovered-tail');
  await complete('loadMore', page([2, 1]));
  assert.equal(calls[2].cursor, 'recovered-tail');
  assert.deepEqual(state().photos.map((item) => item.id), ids([4, 3, 2, 1]));
});

test('a burst larger than one page stays reachable through gap pages before the original older cursor', async (t) => {
  const { calls, state, complete } = setup(t);
  await complete('refresh', page([4, 3], 'original-tail'));
  await complete('check', page([10, 9], 'gap-a'));
  assert.equal(state().nextCursor, 'gap-a');
  await complete('loadMore', page([8, 7], 'gap-b'));
  assert.equal(state().nextCursor, 'gap-b');
  await complete('loadMore', page([6, 5, 4], 'overlapping-page'));
  assert.equal(state().nextCursor, 'original-tail');
  await complete('loadMore', page([2, 1]));
  assert.deepEqual(calls.map((call) => call.cursor), [undefined, undefined, 'gap-a', 'gap-b', 'original-tail']);
  assert.deepEqual(state().photos.map((item) => item.id), ids([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]));
  assert.equal(state().nextCursor, null);
});

test('a second burst queues a newer gap without losing the first and repeated heads do not requeue it', async (t) => {
  const { calls, state, complete } = setup(t);
  await complete('refresh', page([4, 3], 'original-tail'));
  await complete('check', page([8, 7], 'first-gap'));
  await complete('check', page([12, 11], 'second-gap'));
  assert.equal(state().nextCursor, 'second-gap');
  await complete('loadMore', page([10, 9, 8], 'first-gap'));
  assert.equal(state().nextCursor, 'first-gap');
  await complete('loadMore', page([6, 5, 4], 'original-tail'));
  assert.equal(state().nextCursor, 'original-tail');
  await complete('check', page([12, 11], 'second-gap'));
  assert.equal(state().nextCursor, 'original-tail');
  assert.deepEqual(calls.slice(3, 5).map((call) => call.cursor), ['second-gap', 'first-gap']);
  assert.deepEqual(state().photos.map((item) => item.id), ids([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]));
});

test('an empty filtered head preserves its continuation without repeatedly scanning the same gap', async (t) => {
  const { state, complete } = setup(t);
  await complete('refresh', page([4, 3], 'original-tail'));
  await complete('check', page([], 'filtered-head'));
  assert.deepEqual(state().photos.map((item) => item.id), ids([4, 3]));
  assert.equal(state().nextCursor, 'filtered-head');
  await complete('loadMore', page([6, 5, 4], 'original-tail'));
  assert.equal(state().nextCursor, 'original-tail');
  await complete('check', page([], 'filtered-head'));
  assert.equal(state().nextCursor, 'original-tail');
  assert.deepEqual(state().photos.map((item) => item.id), ids([6, 5, 4, 3]));
});

test('same-window head removals do not remove older pages, while a complete index page is authoritative', async (t) => {
  const { state, complete } = setup(t);
  await complete('refresh', page([5, 4], 'head-boundary'));
  await complete('loadMore', page([3, 2], 'older-boundary'));
  await complete('check', page([5], 'head-boundary'));
  assert.deepEqual(state().photos.map((item) => item.id), ids([5, 3, 2]));
  assert.equal(state().nextCursor, 'older-boundary');
  await complete('check', page([6, 5]));
  assert.deepEqual(state().photos.map((item) => item.id), ids([6, 5]));
  assert.equal(state().nextCursor, null);
});

test('an authoritative manual refresh wins over an aborted background response arriving late', async (t) => {
  const { controller, calls, state, complete } = setup(t);
  await complete('refresh', page([4, 3], 'old-tail'));
  const background = controller.check();
  const manual = controller.refresh();
  assert.equal(calls[1].signal.aborted, true);
  calls[2].resolve(page([10], 'fresh-tail'));
  await manual;
  calls[1].resolve(page([99], 'stale-tail'));
  await background;
  assert.deepEqual(state().photos.map((item) => item.id), ids([10]));
  assert.equal(state().nextCursor, 'fresh-tail');
  assert.equal(state().isLoading, false);
});

test('a 404 removal during a request cannot be undone by its stale response, but a later request can restore it', async (t) => {
  const { controller, calls, state, complete } = setup(t);
  await complete('refresh', page([5, 4], 'old-tail'));
  const background = controller.check();
  controller.removePhoto(photo(5).id);
  calls[1].resolve(page([6, 5, 4], 'new-head'));
  await background;
  assert.deepEqual(state().photos.map((item) => item.id), ids([6, 4]));
  await complete('check', page([6, 5, 4], 'new-head'));
  assert.deepEqual(state().photos.map((item) => item.id), ids([6, 5, 4]));
});

test('hidden/offline and lightbox pauses stop checks and resume immediately without interrupting user pagination', async (t) => {
  const { controller, clock, calls, state, complete } = setup(t);
  await complete('refresh', page([4, 3], 'older'));
  controller.setForeground(false);
  assert.equal(clock.timers.size, 0);
  await clock.tick(120_000);
  assert.equal(calls.length, 1);
  controller.setForeground(true);
  assert.equal(calls.length, 2);
  controller.setPaused(true);
  assert.equal(calls[1].signal.aborted, true);
  calls[1].resolve(page([99], 'ignored'));
  await flush();
  assert.deepEqual(state().photos.map((item) => item.id), ids([4, 3]));
  const more = controller.loadMore();
  controller.setForeground(false);
  assert.equal(calls[2].signal.aborted, false);
  calls[2].resolve(page([2, 1]));
  await more;
  controller.setPaused(false);
  assert.equal(calls.length, 3, 'Still offline, so closing the lightbox must not fetch');
  controller.setForeground(true);
  assert.equal(calls.length, 4);
  assert.equal(calls[3].cursor, undefined);
});

test('transient checks retain good content and back off; credential failures stop automatic requests', async (t) => {
  const { controller, clock, calls, state, complete } = setup(t);
  await complete('refresh', page([4], 'older'));
  await clock.tick(30_000);
  calls[1].reject(Object.assign(new Error('Temporary outage'), { status: 503 }));
  await flush();
  assert.equal(state().error, '');
  assert.deepEqual(state().photos.map((item) => item.id), ids([4]));
  await clock.tick(59_999);
  assert.equal(calls.length, 2);
  await clock.tick(1);
  assert.equal(calls.length, 3);
  calls[2].reject(Object.assign(new Error('Temporary outage'), { status: 503 }));
  await flush();
  await clock.tick(120_000);
  assert.equal(calls.length, 4);
  calls[3].reject(Object.assign(new Error('Please enter the guest password again.'), { status: 401 }));
  await flush();
  assert.match(state().error, /guest password/);
  assert.equal(clock.timers.size, 0);
  await clock.tick(600_000);
  assert.equal(calls.length, 4);
  await complete('refresh', page([7], 'new-tail'));
  assert.equal(state().error, '');
  assert.equal(clock.timers.size, 1);
});

test('disposing aborts active work and ignores late responses without leaking timers or updates', async (t) => {
  const { controller, clock, calls, updates } = setup(t);
  const loading = controller.refresh();
  const previousUpdates = updates.length;
  controller.dispose();
  assert.equal(calls[0].signal.aborted, true);
  calls[0].resolve(page([1]));
  await loading;
  await clock.tick(600_000);
  assert.equal(clock.timers.size, 0);
  assert.equal(updates.length, previousUpdates);
  controller.check();
  assert.equal(calls.length, 1);
});
