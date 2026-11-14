import assert from 'node:assert/strict';
import test from 'node:test';
import { createGalleryRepository } from '../src/gallery-repository.mjs';

const instant = new Date('2026-11-21T08:00:00.000Z');
const uuid = (number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const timestamp = (date) => ({ toDate: () => new Date(date) });
const image = (number, changes = {}) => ({
  id: uuid(number), fileId: `file_${number}`, mimeType: 'image/jpeg', size: 1234,
  createdAt: new Date(instant), ...changes,
});
const upload = (number, changes = {}) => ({
  uploadId: uuid(number), fileId: `file_${number}`, mimeType: 'image/jpeg', size: 1234,
  status: 'complete', name: 'a wedding memory.jpg', createdAt: new Date(instant),
  expiresAt: new Date(instant.getTime() + 86400000), sessionUrl: 'private-session', guestName: 'A guest',
  ...changes,
});

function fakeFirestore({ photos = [], uploads = [] } = {}) {
  const collections = {
    weddingPhotoGallery: new Map(photos.map((value) => [value.id, value])),
    weddingPhotoUploads: new Map(uploads.map((value) => [value.uploadId, value])),
  };
  const queries = [];
  const writes = [];
  let serial = Promise.resolve();
  let failSeedQueries = 0;

  function snapshot(collection, id, fields) {
    const data = collections[collection].get(id);
    return {
      id, exists: data !== undefined,
      data: () => fields ? Object.fromEntries(fields.filter((field) => field in data).map((field) => [field, data[field]])) : data,
    };
  }

  function valueFor(row, field) {
    const value = typeof field !== 'string' ? row.id : row.data[field];
    return value?.toDate ? value.toDate().getTime() : value instanceof Date ? value.getTime() : value;
  }

  function query(spec) {
    return {
      doc(id) {
        return { collection: spec.collection, id, get: async () => snapshot(spec.collection, id) };
      },
      where(field, operator, value) { return query({ ...spec, filters: [...spec.filters, { field, operator, value }] }); },
      orderBy(field, direction) { return query({ ...spec, orders: [...spec.orders, { field, direction }] }); },
      select(...fields) { return query({ ...spec, fields }); },
      limit(count) { return query({ ...spec, limit: count }); },
      startAfter(...after) { return query({ ...spec, after }); },
      async get() {
        queries.push(spec);
        if (spec.collection === 'weddingPhotoUploads' && failSeedQueries > 0) {
          failSeedQueries -= 1;
          throw new Error('A temporary Firestore read failure');
        }
        let rows = [...collections[spec.collection]].map(([id, data]) => ({ id, data }));
        for (const { field, operator, value } of spec.filters) {
          assert.equal(operator, '==');
          rows = rows.filter((row) => row.data[field] === value);
        }
        function compare(left, rightValues) {
          for (let index = 0; index < spec.orders.length; index += 1) {
            const { field, direction } = spec.orders[index];
            const a = valueFor(left, field);
            const b = rightValues[index]?.toDate ? rightValues[index].toDate().getTime()
              : rightValues[index] instanceof Date ? rightValues[index].getTime() : rightValues[index];
            const order = a < b ? -1 : a > b ? 1 : 0;
            if (order) return direction === 'desc' ? -order : order;
          }
          return 0;
        }
        rows.sort((a, b) => compare(a, spec.orders.map(({ field }) => valueFor(b, field))));
        if (spec.after) rows = rows.filter((row) => compare(row, spec.after) > 0);
        const docs = rows.slice(0, spec.limit ?? rows.length).map(({ id }) => snapshot(spec.collection, id, spec.fields));
        return { docs };
      },
    };
  }

  return {
    collections, queries, writes,
    failNextSeed() { failSeedQueries += 1; },
    collection(name) {
      assert.ok(name in collections);
      return query({ collection: name, filters: [], orders: [] });
    },
    runTransaction(callback) {
      const run = serial.then(async () => {
        const pending = [];
        const value = await callback({
          get: async (ref) => snapshot(ref.collection, ref.id),
          create(ref, data) {
            assert.equal(collections[ref.collection].has(ref.id), false, 'create must never overwrite an indexed photo');
            pending.push({ ref, data });
          },
          update(ref, data) {
            assert.equal(collections[ref.collection].has(ref.id), true);
            pending.push({ ref, data, update: true });
          },
        });
        for (const { ref, data, update } of pending) {
          collections[ref.collection].set(ref.id, update ? { ...collections[ref.collection].get(ref.id), ...data } : data);
          writes.push({ collection: ref.collection, id: ref.id, data });
        }
        return value;
      });
      serial = run.catch(() => {});
      return run;
    },
  };
}

test('gallery pages have a stable document-ID tie breaker and no duplicates across tied dates', async () => {
  const firestore = fakeFirestore({ photos: Array.from({ length: 7 }, (_, index) => image(index + 1)) });
  const repository = createGalleryRepository(firestore);
  const first = await repository.list({ limit: 3 });
  const second = await repository.list({ limit: 3, cursor: first.nextCursor });
  const third = await repository.list({ limit: 3, cursor: second.nextCursor });
  assert.deepEqual(first.photos.map(({ id }) => id), [uuid(7), uuid(6), uuid(5)]);
  assert.deepEqual(second.photos.map(({ id }) => id), [uuid(4), uuid(3), uuid(2)]);
  assert.deepEqual(third.photos.map(({ id }) => id), [uuid(1)]);
  assert.equal(third.nextCursor, null);
  assert.deepEqual(JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString()), { at: instant.toISOString(), id: uuid(5) });
  const photoQueries = firestore.queries.filter(({ collection }) => collection === 'weddingPhotoGallery');
  assert.equal(photoQueries[0].orders[0].field, 'createdAt');
  assert.deepEqual(photoQueries[0].orders.map(({ direction }) => direction), ['desc', 'desc']);
  assert.equal(photoQueries[0].limit, 4);
  assert.equal(firestore.queries.filter(({ collection }) => collection === 'weddingPhotoUploads').length, 1);
});

test('createdAt takes precedence over ID and Timestamp values become native Dates', async () => {
  const firestore = fakeFirestore({ photos: [
    image(100, { createdAt: timestamp(new Date('2026-11-20T08:00:00.000Z')) }),
    image(1, { createdAt: timestamp(instant) }),
  ] });
  const { photos, nextCursor } = await createGalleryRepository(firestore).list();
  assert.deepEqual(photos.map(({ id }) => id), [uuid(1), uuid(100)]);
  assert.ok(photos.every(({ createdAt }) => createdAt instanceof Date));
  assert.equal(nextCursor, null);
});

test('pagination defaults to 18, caps positive limits at 36, and rejects invalid limits', async () => {
  const firestore = fakeFirestore({ photos: Array.from({ length: 40 }, (_, index) => image(index + 1)) });
  const repository = createGalleryRepository(firestore);
  assert.equal((await repository.list()).photos.length, 18);
  assert.equal((await repository.list({ limit: 100 })).photos.length, 36);
  for (const limit of [0, -1, 1.5, '18', null, NaN, Infinity]) {
    await assert.rejects(repository.list({ limit }), { status: 400 });
  }
});

test('invalid, noncanonical, or oversized cursors are rejected before Firestore is queried', async () => {
  const firestore = fakeFirestore();
  const repository = createGalleryRepository(firestore);
  const encode = (data) => Buffer.from(JSON.stringify(data)).toString('base64url');
  const valid = { at: instant.toISOString(), id: uuid(10) };
  const invalid = [
    '', '?', 'a'.repeat(513), 12, [],
    encode(null), encode([]), encode({}), encode({ ...valid, id: 'not-a-uuid' }),
    encode({ ...valid, id: valid.id.toUpperCase() }),
    encode({ ...valid, at: '2026-11-21' }), encode({ ...valid, at: '2026-02-30T00:00:00.000Z' }),
    encode({ ...valid, at: 'not-a-date' }), encode({ ...valid, extra: true }),
    encode(valid) + '=',
  ];
  for (const cursor of invalid) await assert.rejects(repository.list({ cursor }), { status: 400 });
  assert.equal(firestore.queries.length, 0);
});

test('get validates IDs, normalizes UUID case, and never exposes private upload session fields', async () => {
  const firestore = fakeFirestore({ photos: [image(10, { createdAt: timestamp(instant), expiresAt: instant, sessionUrl: 'secret' })] });
  const repository = createGalleryRepository(firestore);
  const result = await repository.get(uuid(10).toUpperCase());
  assert.deepEqual(result, image(10));
  assert.deepEqual(Object.keys(result).sort(), ['createdAt', 'fileId', 'id', 'mimeType', 'size']);
  assert.equal(await repository.get(uuid(999)), null);
  await assert.rejects(repository.get('../private'), { status: 404 });
  await assert.rejects(repository.get(null), { status: 404 });
  assert.equal(firestore.queries.length, 0, 'get never scans either collection');
});

test('gallery reads return only a normalized optional guest credit beside image metadata', async () => {
  const firestore = fakeFirestore({ photos: [
    image(1, { guestName: '  José\n Cruz\u0000 ', description: 'private note', sessionUrl: 'secret' }),
    image(2, { guestName: { unsafe: 'object' } }), image(3, { guestName: '   ' }),
  ] });
  const repository = createGalleryRepository(firestore);
  assert.deepEqual(await repository.get(uuid(1)), image(1, { guestName: 'José Cruz' }));
  assert.deepEqual(await repository.get(uuid(2)), image(2));
  assert.deepEqual(await repository.get(uuid(3)), image(3));
  assert.equal((await repository.list()).photos.find(({ id }) => id === uuid(1)).guestName, 'José Cruz');
});

test('legacy completed uploads seed durable image-only records and prefer completedAt', async () => {
  const completion = new Date('2026-11-21T10:00:00.000Z');
  const firestore = fakeFirestore({ uploads: [
    upload(1, { createdAt: timestamp(instant), completedAt: timestamp(completion) }),
    upload(2, { mimeType: 'image/heic' }), upload(3, { mimeType: 'video/mp4' }),
    upload(4, { status: 'uploading' }), upload(5, { fileId: '../unsafe' }),
    upload(6, { size: 0 }), upload(7, { size: 500 * 1024 * 1024 + 1 }),
    upload(8, { mimeType: 'image/svg+xml' }), upload(9, { createdAt: new Date(NaN) }),
    upload(10, { name: 'uploader-connection-check.png' }),
    upload(11, { name: `load-test-${uuid(11)}.bmp` }),
  ] });
  const repository = createGalleryRepository(firestore);
  const { photos } = await repository.list();
  assert.deepEqual(photos.map(({ id }) => id), [uuid(1), uuid(2)]);
  assert.equal(photos[0].createdAt.getTime(), completion.getTime());
  assert.equal(photos[1].createdAt.getTime(), instant.getTime());
  for (const write of firestore.writes) {
    assert.equal(write.collection, 'weddingPhotoGallery');
    assert.deepEqual(Object.keys(write.data).sort(), ['createdAt', 'fileId', 'guestName', 'id', 'mimeType', 'size']);
    assert.equal(write.data.guestName, 'A guest');
    assert.ok(write.data.createdAt instanceof Date);
  }
  assert.equal(firestore.collections.weddingPhotoUploads.size, 11);
  const seedQuery = firestore.queries.find(({ collection }) => collection === 'weddingPhotoUploads');
  assert.deepEqual(seedQuery.filters, [{ field: 'status', operator: '==', value: 'complete' }]);
  assert.deepEqual(seedQuery.fields, ['uploadId', 'fileId', 'mimeType', 'size', 'createdAt', 'completedAt', 'status', 'name', 'guestName']);
});

test('backfill is idempotent across concurrent instances and preserves existing timestamps', async () => {
  const indexedAt = new Date('2026-11-22T00:00:00.000Z');
  const firestore = fakeFirestore({ photos: [image(1, { createdAt: indexedAt })], uploads: [upload(1), upload(2), upload(3)] });
  const first = createGalleryRepository(firestore);
  const second = createGalleryRepository(firestore);
  await Promise.all([first.seedCompletedUploads(), first.seedCompletedUploads(), second.seedCompletedUploads()]);
  assert.equal(firestore.writes.length, 3);
  assert.equal(firestore.collections.weddingPhotoGallery.size, 3);
  assert.equal(firestore.collections.weddingPhotoGallery.get(uuid(1)).createdAt, indexedAt);
  assert.deepEqual(firestore.writes.find(({ id }) => id === uuid(1)).data, { guestName: 'A guest' });
  const scans = firestore.queries.length;
  await first.seedCompletedUploads();
  assert.equal(firestore.queries.length, scans);
});

test('legacy credit backfill preserves existing credits and requires matching valid image metadata', async () => {
  const sources = [
    image(1, { guestName: 'Original credit' }), image(2, { fileId: 'other-file' }),
    image(3, { mimeType: 'image/png' }), image(4, { size: 456 }),
    image(5, { createdAt: new Date(NaN) }), image(6, { guestName: '  ' }), image(7),
  ];
  const firestore = fakeFirestore({ photos: sources, uploads: [
    ...Array.from({ length: 6 }, (_, index) => upload(index + 1, { guestName: '  New\n guest\u0000  ' })),
    upload(7, { guestName: undefined }),
  ] });
  await createGalleryRepository(firestore).seedCompletedUploads();
  assert.deepEqual(firestore.writes, [{ collection: 'weddingPhotoGallery', id: uuid(6), data: { guestName: 'New guest' } }]);
  for (const source of sources.filter(({ id }) => id !== uuid(6))) {
    assert.equal(firestore.collections.weddingPhotoGallery.get(source.id), source);
  }
  assert.deepEqual(firestore.collections.weddingPhotoGallery.get(uuid(6)), image(6, { guestName: 'New guest' }));
});

test('a failed seed is retried on the next list instead of poisoning the instance promise', async () => {
  const firestore = fakeFirestore({ uploads: [upload(1)] });
  firestore.failNextSeed();
  const repository = createGalleryRepository(firestore);
  await assert.rejects(repository.list(), /temporary Firestore/);
  assert.equal((await repository.list()).photos.length, 1);
  assert.equal(firestore.writes.length, 1);
});

test('legacy scanning uses bounded pages and stops after 5000 source records', async () => {
  // Videos still count toward the scan bound but do not require transactions.
  const firestore = fakeFirestore({ uploads: Array.from({ length: 5100 }, (_, index) => upload(index + 1, { mimeType: 'video/mp4' })) });
  await createGalleryRepository(firestore).seedCompletedUploads();
  assert.equal(firestore.queries.length, 25);
  assert.ok(firestore.queries.every(({ limit }) => limit <= 200));
  assert.ok(firestore.queries.slice(1).every(({ after }) => after.length === 1));
  assert.equal(firestore.writes.length, 0);
});

test('malformed indexed metadata is excluded from reads', async () => {
  const firestore = fakeFirestore({ photos: [image(1, { fileId: '../unsafe' }), image(2, { size: 0 }), image(3, { mimeType: 'video/mp4' })] });
  const repository = createGalleryRepository(firestore);
  assert.deepEqual((await repository.list()).photos, []);
  assert.equal(await repository.get(uuid(1)), null);
});
