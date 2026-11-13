const previewSearch = (search = '') => (
  new URLSearchParams(search).get('preview') === 'memories' ? '?preview=memories' : ''
);

export const getMemoriesHref = (search = '') => `/memories${previewSearch(search)}`;
export const getWeddingHref = (search = '') => `/${previewSearch(search)}`;

// Old preview bookmarks pointed to photo sections on the homepage. Keep them
// working while leaving the homepage's ordinary preview navigation available.
export function getLegacyMemoriesRedirect({ pathname = '/', search = '', hash = '' } = {}) {
  if (!['/', '/index.html'].includes(pathname) || !['#memories', '#gallery'].includes(hash)
    || !previewSearch(search)) return null;
  return `/memories?${new URLSearchParams(search)}${hash}`;
}
