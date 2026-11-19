import { assetPath, NAV_LINKS } from '../data/wedding.js';

export function Navigation({ page = 'home', countdownComplete = false }) {
  const links = page === 'memories'
    ? [{ href: '/', label: 'Wedding' }]
    : NAV_LINKS.filter((link) => countdownComplete || !link.afterCountdown);
  return (
    <nav className="nav">
      <a href={page === 'memories' ? '/' : '#home'} className="brand">
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
