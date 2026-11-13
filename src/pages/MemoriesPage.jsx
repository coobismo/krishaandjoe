import { Camera } from 'lucide-react';
import { useCallback, useState } from 'react';
import { PasswordGate } from '../components/PasswordGate.jsx';
import { usePhotoAvailability } from '../features/photos/usePhotoAvailability.js';
import { Footer } from '../sections/Footer.jsx';
import { GuestGallery } from '../sections/GuestGallery.jsx';
import { Navigation } from '../sections/Navigation.jsx';
import { PhotoUpload } from '../sections/PhotoUpload.jsx';

export function MemoriesPage() {
  const showGuestPhotos = usePhotoAvailability();
  const isPreview = new URLSearchParams(window.location.search).get('preview') === 'memories';
  const [galleryVersion, setGalleryVersion] = useState(0);
  const refreshAfterUpload = useCallback(() => setGalleryVersion((current) => current + 1), []);

  return (
    <PasswordGate>
      <main className="memoriesPage">
        <Navigation page="memories" showGuestPhotos={showGuestPhotos} />
        <header className="section memoriesPageIntro">
          <p className="eyebrow">Krisha & Joe · November 21, 2026</p>
          <h1>Our shared memories</h1>
          <p>The little moments, the happy tears, and all the love in between.</p>
        </header>
        {showGuestPhotos ? (
          <>
            {isPreview && <aside className="photoPreviewNotice">Photo preview · Guest uploads and the album open on November 21.</aside>}
            <PhotoUpload onUploadsComplete={refreshAfterUpload} />
            <GuestGallery refreshKey={galleryVersion} />
          </>
        ) : (
          <section className="memoriesLaunch" aria-labelledby="memories-launch-title">
            <div className="memoriesLaunchCard">
              <Camera size={32} strokeWidth={1.3} aria-hidden="true" />
              <p className="eyebrow">Opening on our wedding day</p>
              <h2 id="memories-launch-title">November 21, 2026</h2>
              <p>Our shared album opens at midnight in Manila. Come back to share your photos and videos, and see the day through everyone’s eyes.</p>
              <a className="button secondary" href="/">Back to our wedding</a>
            </div>
          </section>
        )}
        <Footer />
      </main>
    </PasswordGate>
  );
}
