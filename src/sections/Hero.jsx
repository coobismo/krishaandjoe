import { HERO } from '../data/wedding.js';

export function Hero({ countdown }) {
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
        <div className="countdown" role="timer" aria-live="off" aria-label={countdown.label}>
          {countdown.isComplete ? (
            <p className="countdownMessage">{countdown.label}</p>
          ) : (
            <div className="countdownUnits" aria-hidden="true">
              {['days', 'hours', 'minutes', 'seconds'].map((unit) => (
                <div className="countdownUnit" key={unit}>
                  <span className="countdownValue">{String(countdown[unit]).padStart(2, '0')}</span>
                  <span className="countdownLabel">{unit}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
