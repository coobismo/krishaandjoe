import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Mail, CheckCircle2, HeartHandshake, CakeSlice } from 'lucide-react';
import './styles.css';

const WEDDING_DATE = new Date('2026-11-21T15:00:00+08:00');
const RSVP_ENDPOINT = import.meta.env.VITE_RSVP_ENDPOINT || '';
const RSVP_STORAGE_KEY = 'krisha-joe-rsvps';
const assetPath = (fileName) => `${import.meta.env.BASE_URL}${fileName}`;
const EMPTY_RSVP_FORM = {
  name: '',
  contactNumber: '',
  attendance: 'yes',
  guests: '1',
  message: '',
};
const CATS = [
  {
    name: 'Cookie',
    image: assetPath('cookie.png'),
    className: 'cookieImage',
  },
  {
    name: 'Biscuit',
    image: assetPath('biscuit.png'),
    className: 'biscuitImage',
  },
  {
    name: "S'mores",
    image: assetPath('smores.png'),
    className: 'smoresImage',
  },
];

function useCountdown() {
  return useMemo(() => {
    const now = new Date();
    const diff = WEDDING_DATE - now;

    if (diff <= 0) {
      return { days: 0, label: 'Today is the day' };
    }

    const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
    return { days, label: `${days} days to go` };
  }, []);
}

function App() {
  const countdown = useCountdown();
  const [form, setForm] = useState(EMPTY_RSVP_FORM);
  const [submission, setSubmission] = useState({ status: 'idle', message: '' });
  const [activeCat, setActiveCat] = useState(null);
  const [, setResponses] = useState(() => {
    const saved = localStorage.getItem(RSVP_STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  });

  function updateField(event) {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  }

  function saveResponseLocally(entry) {
    setResponses((currentResponses) => {
      const updatedResponses = [entry, ...currentResponses];
      localStorage.setItem(RSVP_STORAGE_KEY, JSON.stringify(updatedResponses));
      return updatedResponses;
    });
  }

  async function handleSubmit(event) {
    event.preventDefault();

    const entry = {
      ...form,
      email: form.contactNumber,
      phone: form.contactNumber,
      submittedAt: new Date().toISOString(),
    };

    setSubmission({ status: 'submitting', message: '' });

    try {
      if (!RSVP_ENDPOINT) {
        throw new Error('Missing VITE_RSVP_ENDPOINT');
      }

      await fetch(RSVP_ENDPOINT, {
        method: 'POST',
        mode: 'no-cors',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8',
        },
        body: JSON.stringify(entry),
      });

      saveResponseLocally(entry);
      setSubmission({ status: 'success', message: 'RSVP sent. Thank you!' });
      setForm(EMPTY_RSVP_FORM);
    } catch (error) {
      saveResponseLocally(entry);
      setSubmission({
        status: 'error',
        message: RSVP_ENDPOINT
          ? 'We could not reach the RSVP sheet. Your response was saved in this browser; please try again.'
          : 'The RSVP sheet endpoint is not configured yet. Your response was saved in this browser for now.',
      });
    }
  }

  return (
    <main>
      <nav className="nav">
        <a href="#home" className="brand">
          <img className="brandLogo" src={assetPath('header.png')} alt="Krisha & Joe" />
        </a>
        <div className="navLinks">
          <a href="#details">Details</a>
          <a href="#rsvp">RSVP</a>
          <a href="#faq">FAQ</a>
        </div>
      </nav>

      <section id="home" className="hero section">
        <div className="heroCard">
          <h1 className="heroTitle">
            <span>Our Next</span>
            <span>Chapter Is</span>
            <span className="scriptLine">About to Begin</span>
          </h1>
          <p className="date">November 21, 2026</p>
          <div className="heroActions">
            <a className="button primary" href="#rsvp">RSVP Now</a>
            <a className="button secondary" href="#details">View Details</a>
          </div>
          <div className="countdown">{countdown.label}</div>
        </div>
      </section>

      <section id="details" className="section weddingInfo">
        <div className="eventDetailsGrid">
          <article className="eventDetail">
            <HeartHandshake className="eventIcon" size={62} strokeWidth={1.7} />
            <h3>The Ceremony</h3>
            <p className="eventMeta">
              Saturday, November 21, 2026
              <br />
              4:00 PM
            </p>
            <p className="eventPlace">
              The Marigold Fields
              <br />
              18 Lantern Lane
              <br />
              Sunbright Hollow, Evermere 48210
            </p>
            <p className="eventNote">
              Please arrive 20-30 minutes early to find your seat and take in the
              view before the ceremony begins.
            </p>
            <a className="button primary compact" href="#rsvp">RSVP</a>
          </article>

          <article className="eventDetail">
            <CakeSlice className="eventIcon" size={62} strokeWidth={1.7} />
            <h3>The Celebration</h3>
            <p className="eventMeta">
              Saturday, November 21, 2026
              <br />
              Reception begins at 5:30 PM
            </p>
            <p className="eventPlace">
              The Hearthstone Pavilion
              <br />
              3 Willowcrest Way
              <br />
              Sunbright Hollow, Evermere 48210
            </p>
            <p className="eventNote">
              Dinner, toasts, and plenty of dancing will take place after the ceremony,
              just a short walk from the lawn.
            </p>
            <a
              className="button primary compact"
              href="https://maps.google.com/?q=The+Hearthstone+Pavilion+3+Willowcrest+Way+Sunbright+Hollow+Evermere+48210"
              target="_blank"
              rel="noreferrer"
            >
              View Map
            </a>
          </article>
        </div>
      </section>

      <section id="prewedding" className="section preWedding">
        <p className="eyebrow">Pre-Wedding Preview</p>
          <p className="sectionLead">
            A glimpse of us before the big day.
          </p>
          <br></br>
        <div className="videoFrame">
          <video controls playsInline preload="metadata">
            <source src={assetPath('prewedding_vid_preview_krisha_joe.mp4')} type="video/mp4" />
            Your browser does not support the video tag.
          </video>
        </div>
      </section>

      <section id="gifts" className="section giftsWishes">
        <p className="eyebrow">Gifts & Wishes</p>
          <p className="sectionLead">
           Your presence at our wedding is the greatest gift we could ask for.
          </p>
        <div className="catPortraits" aria-label="Cookie, Biscuit, and S'mores">
          {CATS.map((cat, index) => (
            <button
              aria-label={`Make ${cat.name} blink`}
              aria-pressed={activeCat === index}
              className={`catButton ${activeCat === index ? 'isActive' : ''}`}
              key={cat.name}
              onClick={() => setActiveCat(index)}
              type="button"
            >
              <img className={`catImage ${cat.className}`} src={cat.image} alt={cat.name} />
            </button>
          ))}
        </div>
        <p className="sectionLead giftNote">
          Should you wish to give us something more, monetary gifts would be
          sincerely appreciated. Our three babies have already volunteered to 
          manage the funds.
        </p>
      </section>

      <section id="rsvp" className="section rsvp">
        <div>
          <p className="eyebrow">Kindly respond</p>
          <h2>RSVP</h2>
          <p>
            Send us your response here and it will be added to our RSVP list.
          </p>
        </div>

        <form className="rsvpForm" onSubmit={handleSubmit}>
          <label>
            Full name
            <input required name="name" value={form.name} onChange={updateField} placeholder="Your name" />
          </label>

          <label>
            Contact number
            <input required type="tel" name="contactNumber" value={form.contactNumber} onChange={updateField} placeholder="09XX XXX XXXX" />
          </label>

          <label>
            Will you attend?
            <select name="attendance" value={form.attendance} onChange={updateField}>
              <option value="yes">Yes, joyfully accepts</option>
              <option value="no">Sorry, cannot attend</option>
            </select>
          </label>

          <label>
            Number of guests
            <select name="guests" value={form.guests} onChange={updateField}>
              <option>1</option>
              <option>2</option>
              <option>3</option>
              <option>4</option>
            </select>
          </label>

          <label className="full">
            Message or dietary notes
            <textarea name="message" value={form.message} onChange={updateField} placeholder="Optional" />
          </label>

          <button className="button primary full" type="submit" disabled={submission.status === 'submitting'}>
            {submission.status === 'submitting' ? 'Submitting...' : 'Submit RSVP'}
          </button>

          {submission.status === 'success' && (
            <p className="formMessage success"><CheckCircle2 size={18} /> {submission.message}</p>
          )}

          {submission.status === 'error' && (
            <p className="formMessage error">{submission.message}</p>
          )}
        </form>
      </section>

      <section id="faq" className="section faq">
        <p className="eyebrow">Must-Knows</p>
        <h2>FAQ</h2>
        <details>
          <summary>What should I wear?</summary>
          <p>Answer placeholder. Share the dress code, colors, and any attire notes here.</p>
        </details>
        <details>
          <summary>Can I bring a plus one?</summary>
          <p>Answer placeholder. Let guests know whether plus ones are included in their invitation.</p>
        </details>
        <details>
          <summary>Is there parking?</summary>
          <p>Answer placeholder. Add parking details, valet information, or drop-off instructions here.</p>
        </details>
        <details>
          <summary>What time should I arrive?</summary>
          <p>Answer placeholder. Add your recommended arrival window before the ceremony.</p>
        </details>
        <details>
          <summary>Can I take photos during the ceremony?</summary>
          <p>Answer placeholder. Note whether the ceremony is unplugged or when photos are welcome.</p>
        </details>
        <details>
          <summary>Who do I contact on the wedding day?</summary>
          <p>Answer placeholder. Add the name and contact number of your wedding day point person.</p>
        </details>
        <details>
          <summary>What to expect during cocktail hour?</summary>
          <p>Answer placeholder. Mention refreshments, light bites, photos, or where guests should gather.</p>
        </details>
      </section>

      <footer>
        <Mail size={18} />
        <p>With love, Krisha & Joe · November 21, 2026</p>
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
