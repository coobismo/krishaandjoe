import { useState } from 'react';
import { PasswordGate } from './components/PasswordGate.jsx';
import { useRsvpForm } from './features/rsvp/useRsvpForm.js';
import { usePhotoAvailability } from './features/photos/usePhotoAvailability.js';
import { useCountdown } from './hooks/useCountdown.js';
import { DressCode } from './sections/DressCode.jsx';
import { FaqSection } from './sections/FaqSection.jsx';
import { Footer } from './sections/Footer.jsx';
import { Gifts } from './sections/Gifts.jsx';
import { GratefulHearts } from './sections/GratefulHearts.jsx';
import { GuestGallery } from './sections/GuestGallery.jsx';
import { Hero } from './sections/Hero.jsx';
import { Navigation } from './sections/Navigation.jsx';
import { PreWedding } from './sections/PreWedding.jsx';
import { PhotoUpload } from './sections/PhotoUpload.jsx';
import { RsvpSection } from './sections/RsvpSection.jsx';
import { WebsitePhoto } from './sections/WebsitePhoto.jsx';
import { WeddingDetails } from './sections/WeddingDetails.jsx';

export default function App() {
  const countdown = useCountdown();
  const rsvp = useRsvpForm();
  const showGuestPhotos = usePhotoAvailability();
  const isPhotoPreview = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('preview') === 'memories';
  const [galleryVersion, setGalleryVersion] = useState(0);
  const [activeCat, setActiveCat] = useState(null);
  const [openDropdown, setOpenDropdown] = useState(null);

  function closeDropdown() {
    setOpenDropdown(null);
  }

  function toggleDropdown(name) {
    setOpenDropdown((current) => (current === name ? null : name));
  }

  function submitRsvp(event) {
    closeDropdown();
    return rsvp.submitRsvp(event);
  }

  return (
    <PasswordGate>
      <main>
        <Navigation showGuestPhotos={showGuestPhotos} />
        <Hero countdown={countdown} />
        <PreWedding />
        <WeddingDetails
          onCloseDropdown={closeDropdown}
          onToggleDropdown={toggleDropdown}
          openDropdown={openDropdown}
        />
        <DressCode />
        <WebsitePhoto />
        <GratefulHearts />
        <Gifts activeCat={activeCat} onSelectCat={setActiveCat} />
        <RsvpSection
          form={rsvp.form}
          isAttending={rsvp.isAttending}
          onCloseDropdown={closeDropdown}
          onSubmit={submitRsvp}
          onToggleDropdown={toggleDropdown}
          onUpdateField={rsvp.updateField}
          onUpdateFormValue={rsvp.updateFormValue}
          openDropdown={openDropdown}
          submission={rsvp.submission}
        />
        <FaqSection />
        {showGuestPhotos && <>
          {isPhotoPreview && <aside className="photoPreviewNotice">Photo preview · Guest uploads and the album open on November 21.</aside>}
          <PhotoUpload onUploadsComplete={() => setGalleryVersion((current) => current + 1)} />
          <GuestGallery refreshKey={galleryVersion} />
        </>}
        <Footer />
      </main>
    </PasswordGate>
  );
}
