import { CATS, GIFTS } from '../data/wedding.js';

export function Gifts({ activeCat, onSelectCat }) {
  return (
    <section id="gifts" className="section giftsWishes">
      <p className="eyebrow">{GIFTS.eyebrow}</p>
      <p className="sectionLead">{GIFTS.lead}</p>
      <div className="catPortraits" aria-label="Cookie, Biscuit and Smores">
        {CATS.map((cat, index) => (
          <button
            aria-label={`Make ${cat.name} blink`}
            aria-pressed={activeCat === index}
            className={`catButton ${activeCat === index ? 'isActive' : ''}`}
            key={cat.name}
            onClick={() => onSelectCat(index)}
            type="button"
          >
            <img className={`catImage ${cat.className}`} src={cat.image} alt={cat.name} />
          </button>
        ))}
      </div>
      <p className="sectionLead giftNote">{GIFTS.note}</p>
    </section>
  );
}
