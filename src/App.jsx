import { useState } from 'react';
import { useCountdown } from './hooks/useCountdown.js';
import { DressCode } from './sections/DressCode.jsx';
import { FaqSection } from './sections/FaqSection.jsx';
import { Footer } from './sections/Footer.jsx';
import { Gifts } from './sections/Gifts.jsx';
import { GratefulHearts } from './sections/GratefulHearts.jsx';
import { Hero } from './sections/Hero.jsx';
import { Navigation } from './sections/Navigation.jsx';
import { PreWedding } from './sections/PreWedding.jsx';
import { WebsitePhoto } from './sections/WebsitePhoto.jsx';
import { WeddingDetails } from './sections/WeddingDetails.jsx';

export default function App() {
  const countdown = useCountdown();
  const [activeCat, setActiveCat] = useState(null);
  const [openDropdown, setOpenDropdown] = useState(null);

  function closeDropdown() {
    setOpenDropdown(null);
  }

  function toggleDropdown(name) {
    setOpenDropdown((current) => (current === name ? null : name));
  }

  return (
    <main>
      <Navigation countdownComplete={countdown.isComplete} />
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
      <FaqSection />
      <Footer />
    </main>
  );
}
