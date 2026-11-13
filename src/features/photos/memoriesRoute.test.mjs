import assert from 'node:assert/strict';
import test from 'node:test';
import { getMemoriesRedirect } from './memoriesRoute.mjs';

test('old preview links on the memories page redirect to the clean page without looping', () => {
  for (const pathname of ['/memories', '/memories/', '/memories/index.html']) {
    assert.equal(getMemoriesRedirect({ pathname, search: '?preview=memories' }), '/memories');
    assert.equal(getMemoriesRedirect({ pathname, search: '?preview=memories', hash: '#gallery' }), '/memories#gallery');
    assert.equal(getMemoriesRedirect({ pathname, search: '' }), null);
  }
});

test('existing homepage photo bookmarks reach the corresponding section without a preview query', () => {
  for (const hash of ['#memories', '#gallery']) {
    assert.equal(getMemoriesRedirect({ pathname: '/', search: '?preview=memories', hash }), `/memories${hash}`);
    assert.equal(getMemoriesRedirect({ pathname: '/', hash }), `/memories${hash}`);
  }
  assert.equal(getMemoriesRedirect({ pathname: '/index.html', search: '?preview=memories&source=bookmark', hash: '#gallery' }), '/memories#gallery');
  assert.equal(getMemoriesRedirect({ pathname: '/', search: '?preview=memories' }), '/memories');
});

test('ordinary homepage links and clean memories paths do not redirect', () => {
  for (const location of [
    { pathname: '/', search: '', hash: '' },
    { pathname: '/', search: '?preview=false', hash: '#details' },
    { pathname: '/', search: '', hash: '#details' },
    { pathname: '/memories', search: '', hash: '#gallery' },
    { pathname: '/memories/', search: '', hash: '#memories' },
  ]) assert.equal(getMemoriesRedirect(location), null);
});
