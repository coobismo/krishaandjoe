import { useState } from 'react';
import { PasswordGate } from './components/PasswordGate.jsx';
import { useRsvpForm } from './features/rsvp/useRsvpForm.js';
import { useCountdown } from './hooks/useCountdown.js';
import { DressCode } from './sections/DressCode.jsx';
import { FaqSection } from './sections/FaqSection.jsx';
import { Footer } from './sections/Footer.jsx';
import { Gifts } from './sections/Gifts.jsx';
import { GratefulHearts } from './sections/GratefulHearts.jsx';
import { Hero } from './sections/Hero.jsx';
import { Navigation } from './sections/Navigation.jsx';
import { PreWedding } from './sections/PreWedding.jsx';
import { RsvpSection } from './sections/RsvpSection.jsx';
import { WebsitePhoto } from './sections/WebsitePhoto.jsx';
import { WeddingDetails } from './sections/WeddingDetails.jsx';

export default function App() {
  const countdown = useCountdown();
  const rsvp = useRsvpForm();
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
        <Navigation />
        <Hero countdownLabel={countdown.label} />
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
        <Footer />
      </main>
    </PasswordGate>
  );
}
