import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchGalleryImage } from './galleryClient.mjs';
import { isGalleryVideo } from './galleryMedia.mjs';
import { createGalleryPreviewLoader } from './galleryPreviewLoader.mjs';

const isForeground = () => document.visibilityState !== 'hidden' && navigator.onLine !== false;

export function useGalleryPreview({ endpoint, uploadCode, photo, variant = 'thumbnail', enabled = true, onUnavailable }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const loader = useRef(null);
  const objectUrl = useRef(null);
  const retryTransient = isGalleryVideo(photo);

  useEffect(() => {
    setUrl('');
    setError('');
    if (!enabled) return;
    const preview = createGalleryPreviewLoader({
      foreground: isForeground(), retryTransient,
      load: ({ signal }) => fetchGalleryImage(endpoint, photo.id, { uploadCode, variant, signal }),
      onLoad(blob) {
        const nextUrl = URL.createObjectURL(blob);
        if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = nextUrl;
        setUrl(nextUrl);
        setError('');
      },
      onError(failure) {
        setError(failure?.message || 'This preview is temporarily unavailable.');
        if (failure?.status === 404) onUnavailable?.(photo.id);
      },
    });
    loader.current = preview;
    const updateForeground = () => preview.setForeground(isForeground());
    document.addEventListener('visibilitychange', updateForeground);
    window.addEventListener('online', updateForeground);
    window.addEventListener('offline', updateForeground);
    preview.start();
    return () => {
      preview.dispose();
      if (loader.current === preview) loader.current = null;
      document.removeEventListener('visibilitychange', updateForeground);
      window.removeEventListener('online', updateForeground);
      window.removeEventListener('offline', updateForeground);
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    };
  }, [endpoint, uploadCode, photo.id, variant, enabled, retryTransient, onUnavailable]);

  const retry = useCallback(() => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    setUrl('');
    setError('');
    loader.current?.retry();
  }, []);

  return { url, error, retry };
}
