import { assetPath, NAV_LINKS } from '../data/wedding.js';

export function Navigation() {
  return (
    <nav className="nav">
      <a href="#home" className="brand">
        <img className="brandLogo" src={assetPath('header.png')} alt="Krisha & Joe" />
      </a>
      <div className="navLinks">
        {NAV_LINKS.map((link) => (
          <a href={link.href} key={link.href}>{link.label}</a>
        ))}
      </div>
    </nav>
  );
}
