import { Mail } from 'lucide-react';
import { FOOTER } from '../data/wedding.js';

export function Footer() {
  return (
    <footer>
      <p className="footerMessage">
        <em>{FOOTER.message}</em>
      </p>
      <div className="footerSignature">
        <Mail size={18} />
        <p>
          <span>{FOOTER.signature}</span>
          <span className="footerDivider" aria-hidden="true">&middot;</span>
          <span>{FOOTER.date}</span>
        </p>
      </div>
    </footer>
  );
}
