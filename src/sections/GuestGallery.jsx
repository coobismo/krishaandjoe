import { ArrowLeft, ArrowRight, Images, LoaderCircle, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GuestPhotoImage } from '../components/GuestPhotoImage.jsx';
import { PHOTO_UPLOAD } from '../data/wedding.js';
import { useGuestGallery } from '../features/photos/useGuestGallery.js';
import { isUploadEndpoint } from '../features/photos/uploadPhoto.mjs';

const sharedDate = (value) => new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' }).format(new Date(value));

function PhotoLightbox({ photos, selected, onSelect, onClose, onUnavailable, returnFocusRef }) {
  const dialog = useRef(null);
  const closeButton = useRef(null);
  const index = photos.findIndex((photo) => photo.id === selected.id);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const modal = dialog.current;
    modal.showModal();
    closeButton.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      modal.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
      else returnFocusRef.current?.focus();
    };
  }, []);

  function changePhoto(direction) {
    if (index >= 0 && photos[index + direction]) onSelect(photos[index + direction]);
  }

  return (
    <dialog
      className="guestLightbox"
      ref={dialog}
      aria-labelledby="guest-lightbox-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); changePhoto(-1); }
        if (event.key === 'ArrowRight') { event.preventDefault(); changePhoto(1); }
      }}
    >
      <div className="guestLightboxBody">
        <header className="guestLightboxHeader">
          <div>
            <p id="guest-lightbox-title">A day to remember</p>
            <span>Shared on {sharedDate(selected.createdAt)}</span>
          </div>
          <button aria-label="Close photo" className="guestLightboxControl" onClick={onClose} ref={closeButton} type="button"><X size={24} aria-hidden="true" /></button>
        </header>
        <GuestPhotoImage key={selected.id} endpoint={PHOTO_UPLOAD.endpoint} uploadCode={PHOTO_UPLOAD.uploadCode} photo={selected} variant="preview" onUnavailable={onUnavailable} />
        <footer className="guestLightboxFooter">
          <button aria-label="Previous photo" className="guestLightboxControl" disabled={index <= 0} onClick={() => changePhoto(-1)} type="button"><ArrowLeft size={22} aria-hidden="true" /></button>
          <span role="status" aria-atomic="true">{index >= 0 ? `${index + 1} of ${photos.length}` : 'Guest photo'}</span>
          <button aria-label="Next photo" className="guestLightboxControl" disabled={index < 0 || index >= photos.length - 1} onClick={() => changePhoto(1)} type="button"><ArrowRight size={22} aria-hidden="true" /></button>
        </footer>
      </div>
    </dialog>
  );
}

export function GuestGallery({ refreshKey = 0 }) {
  const { endpoint, uploadCode, provider } = PHOTO_UPLOAD;
  const enabled = provider === 'cloud-run' && isUploadEndpoint(endpoint, provider) && Boolean(uploadCode);
  const [selected, setSelected] = useState(null);
  const gallery = useGuestGallery({ endpoint, uploadCode, enabled, refreshKey, autoRefreshPaused: Boolean(selected) });
  const galleryHeading = useRef(null);
  const closeLightbox = useCallback(() => setSelected(null), []);
  const handleUnavailable = useCallback((photoId) => {
    gallery.removePhoto(photoId);
    setSelected((current) => current?.id === photoId ? null : current);
  }, [gallery.removePhoto]);

  useEffect(() => {
    if (selected && !gallery.photos.some((photo) => photo.id === selected.id)) setSelected(null);
  }, [selected, gallery.photos]);

  return (
    <section className="section guestGallery" id="gallery" aria-labelledby="guest-gallery-title">
      <div className="guestGalleryIntro">
        <Images size={28} strokeWidth={1.4} aria-hidden="true" />
        <p className="eyebrow">Our day, together</p>
        <h2 id="guest-gallery-title" ref={galleryHeading} tabIndex={-1}>The moments you shared</h2>
        <p className="sectionLead">A little collection of love, laughter, and everything in between. Thank you for helping us remember it all.</p>
      </div>
      <div className="guestGalleryContent">
        {enabled && <div className="guestGalleryToolbar"><span>{gallery.photos.length ? `${gallery.photos.length} ${gallery.photos.length === 1 ? 'memory' : 'memories'} to look back on` : 'Our shared album'}</span></div>}
        {!enabled ? (
          <div className="guestGalleryEmpty"><Images size={32} strokeWidth={1.3} aria-hidden="true" /><p>Our shared album is getting ready.</p></div>
        ) : gallery.isLoading && !gallery.photos.length ? (
          <div className="guestGalleryEmpty" role="status"><LoaderCircle className="memorySpinner" size={28} aria-hidden="true" /><p>Gathering your memories…</p></div>
        ) : !gallery.photos.length && !gallery.error ? (
          <div className="guestGalleryEmpty"><Images size={32} strokeWidth={1.3} aria-hidden="true" />{gallery.nextCursor ? <p>More memories are available below.</p> : <><h3>The first memory could be yours.</h3><p>Share a photo above and help us fill this album with moments from our day.</p><a className="button secondary" href="#memories">Share a memory</a></>}</div>
        ) : null}
        {gallery.error && <div className="guestGalleryError" role="alert"><p>{gallery.error}</p><button className="memoryTextButton" onClick={gallery.refresh} type="button">Try again</button></div>}
        {gallery.photos.length > 0 && <div className="guestPhotoGrid">
          {gallery.photos.map((photo, index) => (
            <figure className="guestPhotoCard" key={photo.id}>
              <button aria-label={`Open guest photo ${index + 1}, shared on ${sharedDate(photo.createdAt)}`} type="button" onClick={() => setSelected(photo)}>
                <GuestPhotoImage endpoint={endpoint} uploadCode={uploadCode} photo={photo} onUnavailable={handleUnavailable} />
                <span className="guestPhotoOpen">View memory <ArrowRight size={15} aria-hidden="true" /></span>
              </button>
              <figcaption>Shared with love <span>{sharedDate(photo.createdAt)}</span></figcaption>
            </figure>
          ))}
        </div>}
        {gallery.nextCursor && <div className="guestGalleryMore"><button className="button secondary memoryChoose" disabled={gallery.isLoading || gallery.isLoadingMore} onClick={gallery.loadMore} type="button">{gallery.isLoadingMore && <LoaderCircle className="memorySpinner" size={17} aria-hidden="true" />} {gallery.isLoadingMore ? 'Loading memories…' : 'More memories'}</button></div>}
      </div>
      {selected && <PhotoLightbox photos={gallery.photos} selected={selected} onSelect={setSelected} onClose={closeLightbox} onUnavailable={handleUnavailable} returnFocusRef={galleryHeading} />}
    </section>
  );
}
