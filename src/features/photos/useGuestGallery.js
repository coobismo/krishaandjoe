import { useCallback, useEffect, useRef, useState } from 'react';
import { getGallery } from './galleryClient.mjs';

export function useGuestGallery({ endpoint, uploadCode, enabled, refreshKey }) {
  const [photos, setPhotos] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [refreshCount, setRefreshCount] = useState(0);
  const request = useRef(null);
  const moreInProgress = useRef(false);
  const unavailableIds = useRef(new Set());

  const refresh = useCallback(() => {
    request.current?.abort();
    setRefreshCount((count) => count + 1);
  }, []);

  const removePhoto = useCallback((photoId) => {
    unavailableIds.current.add(photoId);
    setPhotos((current) => current.filter((photo) => photo.id !== photoId));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    request.current = controller;
    // A fresh listing can include a photo restored in Drive. Keep any new
    // 404s discovered while this request runs out of its eventual result.
    unavailableIds.current.clear();
    moreInProgress.current = false;
    setIsLoadingMore(false);
    setIsLoading(true);
    setError('');
    getGallery(endpoint, { uploadCode, signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setPhotos(result.photos.filter((photo) => !unavailableIds.current.has(photo.id)));
        setNextCursor(result.nextCursor);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [endpoint, uploadCode, enabled, refreshKey, refreshCount]);

  useEffect(() => {
    if (!enabled) return;
    let wasHidden = document.visibilityState === 'hidden';
    function refreshWhenVisible() {
      const isHidden = document.visibilityState === 'hidden';
      if (wasHidden && !isHidden) refresh();
      wasHidden = isHidden;
    }
    function refreshRestoredPage(event) {
      if (event.persisted) refresh();
    }
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('pageshow', refreshRestoredPage);
    return () => {
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('pageshow', refreshRestoredPage);
    };
  }, [enabled, refresh]);

  async function loadMore() {
    if (!nextCursor || isLoading || moreInProgress.current || !enabled) return;
    const controller = request.current;
    if (!controller || controller.signal.aborted) return;
    moreInProgress.current = true;
    setIsLoadingMore(true);
    setError('');
    try {
      const result = await getGallery(endpoint, { uploadCode, cursor: nextCursor, signal: controller.signal });
      if (controller.signal.aborted) return;
      setPhotos((current) => [...current, ...result.photos.filter((photo) => (
        !unavailableIds.current.has(photo.id) && !current.some((old) => old.id === photo.id)
      ))]);
      setNextCursor(result.nextCursor);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message);
    } finally {
      if (!controller.signal.aborted) {
        moreInProgress.current = false;
        setIsLoadingMore(false);
      }
    }
  }

  return { photos, nextCursor, isLoading, isLoadingMore, error, loadMore, refresh, removePhoto };
}
