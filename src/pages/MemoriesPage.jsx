import { useCallback, useState } from 'react';
import { PasswordGate } from '../components/PasswordGate.jsx';
import { Footer } from '../sections/Footer.jsx';
import { GuestGallery } from '../sections/GuestGallery.jsx';
import { Navigation } from '../sections/Navigation.jsx';
import { PhotoUpload } from '../sections/PhotoUpload.jsx';

export function MemoriesPage() {
  const [galleryVersion, setGalleryVersion] = useState(0);
  const refreshAfterUpload = useCallback(() => setGalleryVersion((current) => current + 1), []);

  return (
    <PasswordGate>
      <main className="memoriesPage">
        <Navigation page="memories" />
        <header className="section memoriesPageIntro">
          <p className="eyebrow">Krisha & Joe · November 21, 2026</p>
          <h1>Our shared memories</h1>
          <p>The little moments, the happy tears, and all the love in between.</p>
        </header>
        <PhotoUpload onUploadsComplete={refreshAfterUpload} />
        <GuestGallery refreshKey={galleryVersion} />
        <Footer />
      </main>
    </PasswordGate>
  );
}
