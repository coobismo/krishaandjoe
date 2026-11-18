import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { parseHTML } from 'linkedom';
import { createServer } from 'vite';

const endpoint = 'https://video-tests.example.com';
const photo = { id: 'd8a39d0c-e0f7-4076-ac7e-7bef757716e0', mimeType: 'video/mp4' };
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
let vite;
let GuestVideoPlayer;
let createRoot;

before(async () => {
  // Load the production JSX and its real client/hooks; only the DOM, native
  // decoder, and HTTP responses are simulated in these lifecycle regressions.
  vite = await createServer({
    root: projectRoot, configFile: false, envDir: false, logLevel: 'silent',
    appType: 'custom', server: { host: '127.0.0.1', middlewareMode: true, hmr: false, watch: null },
  });
  ({ GuestVideoPlayer } = await vite.ssrLoadModule('/src/components/GuestVideoPlayer.jsx'));
});

after(async () => { await vite?.close(); });

function replaceGlobal(name, value, saved) {
  saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const settle = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };
const tick = async (t, duration) => {
  await act(async () => { t.mock.timers.tick(duration); await settle(); });
};
const bufferingStatus = (harness) => harness.container.querySelector('[role="status"]');

async function setup(t, { initialPoster = 'blob:existing-grid-thumbnail' } = {}) {
  const saved = new Map();
  const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const requests = [];
  const videos = [];
  const revoked = [];
  let blobCount = 0;
  for (const [name, value] of Object.entries({
    window, document, navigator: { onLine: true, userAgent: 'video-lifecycle-test' },
    HTMLElement: window.HTMLElement, Node: window.Node, React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) replaceGlobal(name, value, saved);

  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = () => `blob:test-preview-${++blobCount}`;
  URL.revokeObjectURL = (url) => revoked.push(url);
  replaceGlobal('fetch', (url, options) => new Promise((resolve, reject) => {
    requests.push({ url: String(url), ...options, resolve, reject });
  }), saved);

  const createElement = document.createElement.bind(document);
  document.createElement = (name, options) => {
    const element = createElement(name, options);
    if (name.toLowerCase() !== 'video') return element;
    const media = { element, sourceChanges: [], playCalls: 0, pauseCalls: 0, loadCalls: 0, paused: true, ended: false, readyState: 3 };
    const setAttribute = element.setAttribute.bind(element);
    const removeAttribute = element.removeAttribute.bind(element);
    element.setAttribute = (attribute, value) => {
      if (attribute.toLowerCase() === 'src') media.sourceChanges.push(String(value));
      return setAttribute(attribute, value);
    };
    element.removeAttribute = (attribute) => {
      if (attribute.toLowerCase() === 'src') media.sourceChanges.push(null);
      return removeAttribute(attribute);
    };
    Object.defineProperty(element, 'src', {
      configurable: true, get: () => element.getAttribute('src') || '',
      set: (value) => element.setAttribute('src', value),
    });
    for (const property of ['paused', 'ended', 'readyState']) {
      Object.defineProperty(element, property, { configurable: true, get: () => media[property] });
    }
    element.play = () => { media.playCalls += 1; media.paused = false; return Promise.resolve(); };
    element.pause = () => { media.pauseCalls += 1; media.paused = true; };
    element.load = () => { media.loadCalls += 1; };
    videos.push(media);
    return element;
  };

  // React DOM detects the available DOM when its client is first imported.
  ({ createRoot } = await import('react-dom/client'));
  const container = document.getElementById('root');
  const root = createRoot(container);
  let mounted = true;
  const props = { endpoint, uploadCode: 'test-upload-code', photo, initialPoster };
  const render = async (changes = {}) => {
    Object.assign(props, changes);
    await act(async () => { root.render(React.createElement(GuestVideoPlayer, props)); await settle(); });
  };
  const dispatch = async (target, type) => {
    await act(async () => { target.dispatchEvent(new window.Event(type, { bubbles: true })); await settle(); });
  };
  const resolveTicket = async () => {
    const request = requests.find((item) => item.url.endsWith('/playback'));
    assert.ok(request, 'The selected video requests its playback ticket');
    await act(async () => {
      request.resolve(new Response(JSON.stringify({
        ok: true, token: 'safe-token.signature', mimeType: 'video/mp4',
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      }), { headers: { 'Content-Type': 'application/json' } }));
      await settle();
    });
    return request;
  };
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => { root.unmount(); await settle(); });
  };
  t.after(async () => {
    await unmount();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  await render();
  return { container, requests, videos, revoked, render, dispatch, resolveTicket, unmount };
}

function assertContinuousPlayer(harness, media, source) {
  assert.equal(harness.container.querySelector('video'), media.element, 'The native player must remain the same DOM element');
  assert.equal(harness.videos.length, 1, 'State changes must not recreate the native player');
  assert.deepEqual(media.sourceChanges, [source], 'The source must be assigned once, without removal or reassignment');
  assert.equal(media.loadCalls, 0, 'Playback state changes must not reset the native resource');
  assert.equal(media.pauseCalls, 0, 'Buffering and poster updates must not pause playback');
  assert.equal(media.element.getAttribute('preload'), 'auto', 'The selected player buffers continuously across metadata and playback');
  assert.equal(media.element.hasAttribute('hidden'), false, 'The native player stays rendered throughout playback');
  assert.equal(media.element.hasAttribute('controls'), true, 'Native controls remain stable');
  assert.equal(media.element.hasAttribute('poster'), false, 'Late poster images must not mutate the native resource presentation');
  assert.equal(harness.requests.filter((request) => request.url.endsWith('/playback')).length, 1);
}

test('video buffering, resume, and parent updates retain one native player and one source', async (t) => {
  const harness = await setup(t);
  await harness.resolveTicket();
  const media = harness.videos[0];
  const source = media.element.getAttribute('src');
  assert.match(source, /\/video\?token=/);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assertContinuousPlayer(harness, media, source);
  await harness.dispatch(harness.container.querySelector('.guestVideoPlay'), 'click');
  assert.equal(media.playCalls, 1);
  await harness.dispatch(media.element, 'playing');
  assert.equal(harness.container.querySelector('.guestVideoPoster'), null);
  media.readyState = 2;
  await harness.dispatch(media.element, 'waiting');
  assert.equal(bufferingStatus(harness), null);
  await tick(t, 250);
  await harness.dispatch(media.element, 'waiting');
  await tick(t, 249);
  assert.equal(bufferingStatus(harness), null);
  await tick(t, 1);
  assert.equal(harness.container.querySelector('.guestVideoBuffering'), null, 'A stall must not overlay a video that has already played');
  assert.ok(harness.container.querySelector('.srOnly[role="status"]'));
  await harness.render({ photo: { ...photo, guestName: 'Updated guest' }, onUnavailable: () => {}, initialPoster: 'blob:late-grid-thumbnail' });
  await harness.dispatch(media.element, 'progress');
  assertContinuousPlayer(harness, media, source);
  media.readyState = 3;
  await harness.dispatch(media.element, 'playing');
  assert.equal(bufferingStatus(harness), null);
  assertContinuousPlayer(harness, media, source);
  assert.equal(media.playCalls, 1, 'Buffering resumes through the existing native play operation');
  await harness.unmount();
  assert.equal(media.pauseCalls, 1);
  assert.equal(media.loadCalls, 1);
  assert.deepEqual(media.sourceChanges, [source, null]);
});

test('a thumbnail arriving after playback starts cannot reset the video source', async (t) => {
  const harness = await setup(t, { initialPoster: '' });
  await harness.resolveTicket();
  const image = harness.requests.find((request) => request.url.includes('/image?variant=thumbnail'));
  assert.ok(image, 'An unavailable grid poster uses the thumbnail fallback');
  const media = harness.videos[0];
  const source = media.element.getAttribute('src');
  await harness.dispatch(harness.container.querySelector('.guestVideoPlay'), 'click');
  await harness.dispatch(media.element, 'playing');
  await harness.dispatch(media.element, 'waiting');
  await act(async () => {
    image.resolve(new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
      headers: { 'Content-Type': 'image/jpeg' },
    }));
    await settle();
  });
  assertContinuousPlayer(harness, media, source);
  await harness.dispatch(media.element, 'playing');
  assertContinuousPlayer(harness, media, source);
  await harness.unmount();
  assert.deepEqual(harness.revoked, ['blob:test-preview-1']);
  assert.equal(media.pauseCalls, 1);
  assert.equal(media.loadCalls, 1);
});

test('ready playback and spurious waiting do not show a custom loading indicator', async (t) => {
  const harness = await setup(t);
  await harness.resolveTicket();
  const media = harness.videos[0];
  const source = media.element.getAttribute('src');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await harness.dispatch(harness.container.querySelector('.guestVideoPlay'), 'click');
  assert.equal(bufferingStatus(harness), null);
  await tick(t, 1000);
  assert.equal(bufferingStatus(harness), null);
  await harness.dispatch(media.element, 'playing');
  await harness.dispatch(media.element, 'waiting');
  await tick(t, 1000);
  assert.equal(bufferingStatus(harness), null);
  assertContinuousPlayer(harness, media, source);
});

test('a sustained initial wait shows a delayed loader while retaining the poster and source', async (t) => {
  const harness = await setup(t);
  await harness.resolveTicket();
  const media = harness.videos[0];
  const source = media.element.getAttribute('src');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  media.readyState = 2;
  await harness.dispatch(harness.container.querySelector('.guestVideoPlay'), 'click');
  assert.equal(bufferingStatus(harness), null);
  await tick(t, 499);
  assert.equal(bufferingStatus(harness), null);
  await tick(t, 1);
  assert.ok(harness.container.querySelector('.guestVideoBuffering'));
  assert.ok(harness.container.querySelector('.guestVideoPoster'));
  assertContinuousPlayer(harness, media, source);
  media.readyState = 3;
  await harness.dispatch(media.element, 'canplay');
  assert.equal(bufferingStatus(harness), null);
  await harness.dispatch(media.element, 'playing');
  assert.equal(harness.container.querySelector('.guestVideoPoster'), null);
  assertContinuousPlayer(harness, media, source);
});

test('brief waits do not flash and canplay clears a real stall without another playing event', async (t) => {
  const harness = await setup(t);
  await harness.resolveTicket();
  const media = harness.videos[0];
  const source = media.element.getAttribute('src');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await harness.dispatch(harness.container.querySelector('.guestVideoPlay'), 'click');
  await harness.dispatch(media.element, 'playing');
  media.readyState = 2;
  await harness.dispatch(media.element, 'waiting');
  await tick(t, 300);
  media.readyState = 3;
  await harness.dispatch(media.element, 'playing');
  await tick(t, 1000);
  assert.equal(bufferingStatus(harness), null);

  media.readyState = 2;
  await harness.dispatch(media.element, 'waiting');
  await tick(t, 500);
  assert.equal(harness.container.querySelector('.guestVideoBuffering'), null);
  assert.ok(harness.container.querySelector('.srOnly[role="status"]'));
  media.readyState = 3;
  await harness.dispatch(media.element, 'canplay');
  assert.equal(bufferingStatus(harness), null);
  assertContinuousPlayer(harness, media, source);
});

test('waiting ignores paused and ended videos and rechecks readiness at the deadline', async (t) => {
  const harness = await setup(t);
  await harness.resolveTicket();
  const media = harness.videos[0];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await harness.dispatch(harness.container.querySelector('.guestVideoPlay'), 'click');
  await harness.dispatch(media.element, 'playing');
  media.readyState = 2;
  media.paused = true;
  await harness.dispatch(media.element, 'waiting');
  await tick(t, 500);
  assert.equal(bufferingStatus(harness), null);
  media.paused = false;
  media.ended = true;
  await harness.dispatch(media.element, 'waiting');
  await tick(t, 500);
  assert.equal(bufferingStatus(harness), null);
  media.ended = false;
  await harness.dispatch(media.element, 'waiting');
  await tick(t, 300);
  media.readyState = 3;
  await tick(t, 200);
  assert.equal(bufferingStatus(harness), null, 'Readiness is rechecked even when no readiness event arrives');
});

test('pause, end, errors, and cleanup cancel a pending loading indicator', async (t) => {
  for (const event of ['pause', 'ended', 'error', 'cleanup']) {
    await t.test(event, async (t) => {
      const harness = await setup(t);
      await harness.resolveTicket();
      const media = harness.videos[0];
      t.mock.timers.enable({ apis: ['setTimeout'] });
      await harness.dispatch(harness.container.querySelector('.guestVideoPlay'), 'click');
      await harness.dispatch(media.element, 'playing');
      media.readyState = 2;
      await harness.dispatch(media.element, 'waiting');
      await tick(t, 200);
      if (event === 'cleanup') await harness.unmount();
      else {
        if (event === 'pause') media.paused = true;
        if (event === 'ended') media.ended = true;
        await harness.dispatch(media.element, event);
        // A later native state change must not revive the old waiting timer.
        media.paused = false;
        media.ended = false;
      }
      await tick(t, 1000);
      assert.equal(bufferingStatus(harness), null);
      assert.equal(media.loadCalls, event === 'cleanup' ? 1 : 0);
      if (event === 'error') assert.ok(harness.container.querySelector('.guestVideoError'));
    });
  }
});

test('closing during ticket preparation cancels the request and ignores its late result', async (t) => {
  const harness = await setup(t);
  const ticket = harness.requests.find((request) => request.url.endsWith('/playback'));
  const media = harness.videos[0];
  assert.equal(ticket.signal.aborted, false);
  await harness.unmount();
  assert.equal(ticket.signal.aborted, true);
  assert.equal(media.pauseCalls, 1);
  assert.equal(media.loadCalls, 1);
  assert.deepEqual(media.sourceChanges, [null]);
  await harness.resolveTicket();
  assert.equal(harness.container.children.length, 0);
  assert.deepEqual(media.sourceChanges, [null], 'A late ticket must not attach a source after cleanup');
  assert.equal(media.pauseCalls, 1);
  assert.equal(media.loadCalls, 1);
});
