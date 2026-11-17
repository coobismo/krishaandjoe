import { LoaderCircle, Play, RotateCw, Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getGalleryPlayback } from '../features/photos/galleryClient.mjs';
import { useGalleryPreview } from '../features/photos/useGalleryPreview.js';

const playbackError = 'We couldn’t play this video. Please try again. Some video formats may need a different browser.';

export function GuestVideoPlayer({ endpoint, uploadCode, photo, initialPoster = '', onUnavailable }) {
  const video = useRef(null);
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;
  const [posterFailed, setPosterFailed] = useState(false);
  const [loadPoster, setLoadPoster] = useState(!initialPoster);
  const { url: posterUrl, retry: retryPoster } = useGalleryPreview({
    endpoint, uploadCode, photo, variant: 'thumbnail', enabled: loadPoster, onUnavailable,
  });
  const poster = posterFailed ? '' : posterUrl || initialPoster;
  const [playback, setPlayback] = useState(null);
  const [isPreparing, setIsPreparing] = useState(true);
  const [isStarted, setIsStarted] = useState(false);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => setPosterFailed(false), [posterUrl]);

  useEffect(() => {
    const controller = new AbortController();
    const media = video.current;
    setPlayback(null);
    setIsPreparing(true);
    setIsStarted(false);
    setHasPlayed(false);
    setIsBuffering(false);
    setError('');

    // Authorize once and let this one open video's native player keep buffering.
    // UI updates and callback changes must not tear down its existing stream.
    getGalleryPlayback(endpoint, photo.id, { uploadCode, signal: controller.signal })
      .then((ticket) => {
        if (controller.signal.aborted) return;
        setPlayback(ticket);
        setIsPreparing(false);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure.status === 404) unavailable.current?.(photo.id);
        setError(failure.message || 'We couldn’t prepare this video. Please try again.');
        setIsPreparing(false);
      });

    return () => {
      controller.abort();
      // Release the native stream when closing, retrying, or changing memories.
      media?.pause();
      media?.removeAttribute('src');
      media?.load();
    };
  }, [endpoint, uploadCode, photo.id, attempt]);

  function failPlayback() {
    if (!video.current?.getAttribute('src')) return;
    video.current.pause();
    setIsStarted(false);
    setHasPlayed(false);
    setIsBuffering(false);
    setError(playbackError);
  }

  function play() {
    if (!playback || isPreparing) return;
    if (Date.parse(playback.expiresAt) <= Date.now() + 5000) {
      setAttempt((current) => current + 1);
      return;
    }
    setError('');
    setIsStarted(true);
    setIsBuffering(true);
    try {
      const media = video.current;
      // Keep the same source, element and controls through buffering/resume.
      // Calling play directly preserves the browser's user-gesture permission.
      const started = media.play();
      started?.catch((failure) => {
        if (video.current !== media || !media.getAttribute('src')) return;
        if (failure?.name === 'AbortError') {
          setIsStarted(false);
          setIsBuffering(false);
        } else failPlayback();
      });
    } catch { failPlayback(); }
  }

  return (
    <div className="guestVideoPlayer">
      {!hasPlayed && (poster
        ? <img className="guestVideoPoster" src={poster} alt="A wedding video shared by a guest" onError={() => { setPosterFailed(true); setLoadPoster(true); }} />
        : <div className="guestPhotoPlaceholder"><Video size={40} strokeWidth={1.3} aria-hidden="true" /></div>)}
      <video
        aria-hidden={!hasPlayed}
        className={`guestVideoMedia${!hasPlayed ? ' isStarting' : ''}`}
        controls
        crossOrigin="anonymous"
        onError={failPlayback}
        onPause={() => { setIsBuffering(false); if (!hasPlayed) setIsStarted(false); }}
        onPlaying={() => { setHasPlayed(true); setIsBuffering(false); }}
        onWaiting={() => setIsBuffering(true)}
        playsInline
        preload="auto"
        ref={video}
        src={playback?.url}
        tabIndex={hasPlayed ? 0 : -1}
      >
        Your browser does not support video playback.
      </video>
      {!isStarted && !error && <button aria-label={isPreparing ? 'Preparing video' : 'Play video'} className="guestVideoPlay" disabled={isPreparing} onClick={play} type="button">
        {isPreparing ? <LoaderCircle className="memorySpinner" size={29} aria-hidden="true" /> : <Play size={31} fill="currentColor" aria-hidden="true" />}
      </button>}
      {isBuffering && isStarted && <span className="guestVideoBuffering" role="status"><LoaderCircle className="memorySpinner" size={28} aria-hidden="true" /><span className="srOnly">Loading video…</span></span>}
      {error && <div className="guestVideoError" role="alert"><p>{error}</p><button className="button secondary" onClick={() => { retryPoster(); setAttempt((current) => current + 1); }} type="button"><RotateCw size={16} aria-hidden="true" /> Try again</button></div>}
    </div>
  );
}
