import { HERO } from '../data/wedding.js';

export function Hero({ countdownLabel }) {
  return (
    <section id="home" className="hero section">
      <div className="heroCard">
        <h1 className="heroTitle">
          <span>{HERO.title}</span>
        </h1>
        <p className="date">{HERO.date}</p>
        <div className="heroActions">
          {HERO.actions.map((action) => (
            <a className={`button ${action.className}`} href={action.href} key={action.href}>
              {action.label}
            </a>
          ))}
        </div>
        <div className="countdown">{countdownLabel}</div>
      </div>
    </section>
  );
}
