import { WEBSITE_PHOTO } from '../data/wedding.js';

export function WebsitePhoto() {
  return (
    <section
      aria-label={WEBSITE_PHOTO.label}
      className="websitePhotoSection"
      style={{ '--website-photo': `url(${WEBSITE_PHOTO.image})` }}
    >
      <span className="srOnly">{WEBSITE_PHOTO.screenReaderText}</span>
    </section>
  );
}
