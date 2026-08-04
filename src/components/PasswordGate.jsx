import { ArrowRight, LockKeyhole } from 'lucide-react';
import { useState } from 'react';

const DEFAULT_PASSWORD = 'krishajoe2026';
const ACCESS_STORAGE_KEY = 'krisha-joe-site-access';

const getSitePassword = () => (
  import.meta.env.VITE_SITE_PASSWORD || DEFAULT_PASSWORD
).trim();

export function PasswordGate({ children }) {
  const sitePassword = getSitePassword();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isUnlocked, setIsUnlocked] = useState(() => {
    if (!sitePassword) {
      return true;
    }

    try {
      return window.localStorage.getItem(ACCESS_STORAGE_KEY) === sitePassword;
    } catch {
      return false;
    }
  });

  function unlockSite(event) {
    event.preventDefault();

    if (password.trim() !== sitePassword) {
      setError('That password does not match. Please try again.');
      setPassword('');
      return;
    }

    try {
      window.localStorage.setItem(ACCESS_STORAGE_KEY, sitePassword);
    } catch {
      // Private browsing can block storage; the in-memory unlock still works.
    }

    setError('');
    setIsUnlocked(true);
  }

  if (isUnlocked) {
    return children;
  }

  return (
    <main className="passwordPage" aria-labelledby="password-title">
      <section className="passwordPanel">
        <div className="passwordIcon" aria-hidden="true">
          <LockKeyhole size={28} strokeWidth={1.8} />
        </div>
        <p className="eyebrow">Krisha & Joe</p>
        <h1 id="password-title" className="passwordTitle">
          Please enter the guest password
        </h1>
        <form className="passwordForm" onSubmit={unlockSite}>
          <label className="srOnly" htmlFor="site-password">
            Guest password
          </label>
          <input
            autoComplete="current-password"
            autoFocus
            className="passwordInput"
            id="site-password"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Guest password"
            type="password"
            value={password}
          />
          <button className="button primary passwordButton" type="submit">
            <span>Enter site</span>
            <ArrowRight size={18} strokeWidth={2} />
          </button>
          {error ? (
            <p className="passwordError" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      </section>
    </main>
  );
}
