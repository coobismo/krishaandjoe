import { useCallback, useEffect, useRef, useState } from 'react';
import { getGallery } from './galleryClient.mjs';
import { createGuestGalleryController, initialGalleryState } from './guestGalleryController.mjs';

const isForeground = () => document.visibilityState !== 'hidden' && navigator.onLine !== false;

export function useGuestGallery({ endpoint, uploadCode, enabled, refreshKey, autoRefreshPaused = false }) {
  const [state, setState] = useState(() => ({ ...initialGalleryState(), isLoading: enabled }));
  const controller = useRef(null);
  const paused = useRef(autoRefreshPaused);
  const lastRefreshKey = useRef(refreshKey);
  paused.current = autoRefreshPaused;

  useEffect(() => {
    if (!enabled) { setState(initialGalleryState()); return; }
    const gallery = createGuestGalleryController({
      getPage: (options) => getGallery(endpoint, { ...options, uploadCode }),
      onChange: setState, foreground: isForeground(), paused: paused.current,
    });
    controller.current = gallery;
    lastRefreshKey.current = refreshKey;
    gallery.refresh();
    const updateForeground = () => gallery.setForeground(isForeground());
    const restoredPage = (event) => {
      if (event.persisted && !gallery.setForeground(isForeground())) gallery.check();
    };
    document.addEventListener('visibilitychange', updateForeground);
    window.addEventListener('online', updateForeground);
    window.addEventListener('offline', updateForeground);
    window.addEventListener('pageshow', restoredPage);
    return () => {
      gallery.dispose();
      if (controller.current === gallery) controller.current = null;
      document.removeEventListener('visibilitychange', updateForeground);
      window.removeEventListener('online', updateForeground);
      window.removeEventListener('offline', updateForeground);
      window.removeEventListener('pageshow', restoredPage);
    };
  }, [endpoint, uploadCode, enabled]);

  useEffect(() => { controller.current?.setPaused(autoRefreshPaused); }, [autoRefreshPaused]);
  useEffect(() => {
    if (lastRefreshKey.current === refreshKey) return;
    lastRefreshKey.current = refreshKey;
    controller.current?.refresh({ preservePhotos: true });
  }, [refreshKey]);

  const refresh = useCallback(() => controller.current?.refresh(), []);
  const loadMore = useCallback(() => controller.current?.loadMore(), []);
  const removePhoto = useCallback((id) => controller.current?.removePhoto(id), []);
  return { ...state, refresh, loadMore, removePhoto };
}
