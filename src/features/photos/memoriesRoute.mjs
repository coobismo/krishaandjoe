// Keep old photo bookmarks working without carrying a preview mode forward.
export function getMemoriesRedirect({ pathname = '/', search = '', hash = '' } = {}) {
  const params = new URLSearchParams(search);
  const photoHash = ['#memories', '#gallery'].includes(hash) ? hash : '';
  const isOldHomeLink = ['/', '/index.html'].includes(pathname)
    && (photoHash || params.get('preview') === 'memories');
  const isOldPreview = ['/memories', '/memories/', '/memories/index.html'].includes(pathname)
    && params.has('preview');
  return isOldHomeLink || isOldPreview ? `/memories${photoHash}` : null;
}
