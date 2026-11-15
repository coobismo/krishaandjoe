import { Image, LoaderCircle, RotateCw, Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fetchGalleryImage } from '../features/photos/galleryClient.mjs';
import { isGalleryVideo } from '../features/photos/galleryMedia.mjs';

const VIDEO_THUMBNAIL_RETRY_DELAYS = [3000, 8000, 15000, 30000];

export function GuestPhotoImage({ endpoint, uploadCode, photo, variant = 'thumbnail', onUnavailable }) {
  const isVideo = isGalleryVideo(photo);
  const element = useRef(null);
  const [isVisible, setIsVisible] = useState(variant === 'preview');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

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

  useEffect(() => {
    if (!isVisible) return;
    const controller = new AbortController();
    let objectUrl;
    let retryTimer;
    setError('');
    setUrl('');
    fetchGalleryImage(endpoint, photo.id, { uploadCode, variant, signal: controller.signal })
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure.status === 404) onUnavailable?.(photo.id);
        setError(failure.message);
        if (isVideo && variant === 'thumbnail' && failure.status === 503 && attempt < VIDEO_THUMBNAIL_RETRY_DELAYS.length) {
          retryTimer = setTimeout(() => {
            if (!controller.signal.aborted) setAttempt((current) => current + 1);
          }, VIDEO_THUMBNAIL_RETRY_DELAYS[attempt]);
        }
      });
    return () => {
      controller.abort();
      clearTimeout(retryTimer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [endpoint, uploadCode, photo.id, variant, isVisible, isVideo, attempt, onUnavailable]);

  return (
    <div className={`guestPhotoImage guestPhotoImage-${variant}`} ref={element}>
      {url && !error ? (
        <img alt={variant === 'preview' ? 'A wedding moment shared by a guest' : ''} src={url} decoding="async" onError={() => setError('This preview could not be displayed. Please try again.')} />
      ) : error ? (
        <div className="guestPhotoPlaceholder">
          {isVideo ? <Video size={26} strokeWidth={1.4} aria-hidden="true" /> : <Image size={26} strokeWidth={1.4} aria-hidden="true" />}
          <p>{variant === 'preview' ? error : isVideo ? 'Tap to watch this memory' : 'Tap to view this memory'}</p>
          {variant === 'preview' && <button className="button secondary" type="button" onClick={() => setAttempt((current) => current + 1)}><RotateCw size={15} aria-hidden="true" /> Retry preview</button>}
        </div>
      ) : (
        <div className="guestPhotoPlaceholder" aria-label="Loading photo">
          <LoaderCircle className="memorySpinner" size={24} strokeWidth={1.4} aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
