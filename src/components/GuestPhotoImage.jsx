import { Image, LoaderCircle, RotateCw, Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { isGalleryVideo } from '../features/photos/galleryMedia.mjs';
import { useGalleryPreview } from '../features/photos/useGalleryPreview.js';

export function GuestPhotoImage({ endpoint, uploadCode, photo, variant = 'thumbnail', onUnavailable }) {
  const isVideo = isGalleryVideo(photo);
  const element = useRef(null);
  const [isVisible, setIsVisible] = useState(variant === 'preview');
  const [decodeError, setDecodeError] = useState('');
  const { url, error: requestError, retry } = useGalleryPreview({
    endpoint, uploadCode, photo, variant, enabled: isVisible, onUnavailable,
  });
  const error = requestError || decodeError;

  useEffect(() => setDecodeError(''), [url]);

  useEffect(() => {
    if (isVisible) return;
    if (!('IntersectionObserver' in window)) { setIsVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setIsVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '250px' });
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, [isVisible]);

  return (
    <div className={`guestPhotoImage guestPhotoImage-${variant}`} ref={element}>
      {url && !error ? (
        <img alt={variant === 'preview' ? 'A wedding moment shared by a guest' : ''} src={url} decoding="async" onError={() => setDecodeError('This preview could not be displayed. Please try again.')} />
      ) : error ? (
        <div className="guestPhotoPlaceholder">
          {isVideo ? <Video size={26} strokeWidth={1.4} aria-hidden="true" /> : <Image size={26} strokeWidth={1.4} aria-hidden="true" />}
          <p>{variant === 'preview' ? error : isVideo ? 'Tap to watch this memory' : 'Tap to view this memory'}</p>
          {variant === 'preview' && <button className="button secondary" type="button" onClick={() => { setDecodeError(''); retry(); }}><RotateCw size={15} aria-hidden="true" /> Retry preview</button>}
        </div>
      ) : (
        <div className="guestPhotoPlaceholder" aria-label="Loading photo">
          <LoaderCircle className="memorySpinner" size={24} strokeWidth={1.4} aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
