import { assetPath, NAV_LINKS } from '../data/wedding.js';
import { getMemoriesHref, getWeddingHref } from '../features/photos/memoriesRoute.mjs';

export function Navigation({ showGuestPhotos = false, page = 'home' }) {
  const search = typeof window === 'undefined' ? '' : window.location.search;
  const weddingHref = getWeddingHref(search);
  const links = page === 'memories'
    ? [
      { href: weddingHref, label: 'Wedding' },
      ...(showGuestPhotos ? [
        { href: '#memories', label: 'Upload' },
        { href: '#gallery', label: 'Gallery' },
      ] : [{ href: `${weddingHref}#details`, label: 'Details' }]),
    ]
    : NAV_LINKS.filter((link) => showGuestPhotos || !link.guestPhotos)
      .map((link) => link.guestPhotos ? { ...link, href: getMemoriesHref(search) } : link);
  return (
    <nav className="nav">
      <a href={page === 'memories' ? weddingHref : '#home'} className="brand">
        <img className="brandLogo" src={assetPath('header.png')} alt="Krisha & Joe" />
      </a>
      <div className="navLinks">
        {links.map((link) => (
          <a href={link.href} key={link.href}>{link.label}</a>
        ))}
      </div>
    </nav>
  );
}
