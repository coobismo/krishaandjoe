import assert from 'node:assert/strict';
import test from 'node:test';
import { getLegacyMemoriesRedirect, getMemoriesHref, getWeddingHref } from './memoriesRoute.mjs';

test('preview navigation carries the explicit bypass between the homepage and memories page', () => {
  assert.equal(getMemoriesHref('?preview=memories'), '/memories?preview=memories');
  assert.equal(getWeddingHref('?preview=memories'), '/?preview=memories');
  assert.equal(`${getWeddingHref('?preview=memories')}#details`, '/?preview=memories#details');
  assert.equal(getMemoriesHref('?preview=false'), '/memories');
  assert.equal(getWeddingHref(), '/');
});

test('existing homepage preview bookmarks reach the corresponding section on the dedicated page', () => {
  for (const hash of ['#memories', '#gallery']) {
    assert.equal(getLegacyMemoriesRedirect({ pathname: '/', search: '?preview=memories', hash }), `/memories?preview=memories${hash}`);
  }
  assert.equal(getLegacyMemoriesRedirect({ pathname: '/index.html', search: '?preview=memories&source=bookmark', hash: '#gallery' }), '/memories?preview=memories&source=bookmark#gallery');
});

test('ordinary homepage links and direct memories paths do not redirect or loop', () => {
  for (const location of [
    { pathname: '/', search: '', hash: '#memories' },
    { pathname: '/', search: '?preview=false', hash: '#gallery' },
    { pathname: '/', search: '?preview=memories', hash: '#details' },
    { pathname: '/', search: '?preview=memories', hash: '' },
    { pathname: '/memories', search: '?preview=memories', hash: '#gallery' },
    { pathname: '/memories/', search: '?preview=memories', hash: '#gallery' },
  ]) assert.equal(getLegacyMemoriesRedirect(location), null);
});
