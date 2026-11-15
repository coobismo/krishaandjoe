import { LoaderCircle, Play, RotateCw, Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fetchGalleryImage, getGalleryPlayback } from '../features/photos/galleryClient.mjs';

const playbackError = 'We couldn’t play this video. Please try again. Some video formats may need a different browser.';

export function GuestVideoPlayer({ endpoint, uploadCode, photo, onUnavailable }) {
  const video = useRef(null);
  const [poster, setPoster] = useState('');
  const [playback, setPlayback] = useState(null);
  const [isPreparing, setIsPreparing] = useState(true);
  const [isStarted, setIsStarted] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const media = video.current;
    let posterUrl;
    setPoster('');
    setPlayback(null);
    setIsPreparing(true);
    setIsStarted(false);
    setIsBuffering(false);
    setError('');

    // A missing thumbnail must not prevent an otherwise playable recording.
    fetchGalleryImage(endpoint, photo.id, { uploadCode, variant: 'preview', signal: controller.signal })
      .then((blob) => {
        if (controller.signal.aborted) return;
        posterUrl = URL.createObjectURL(blob);
        setPoster(posterUrl);
      })
      .catch((failure) => {
        if (!controller.signal.aborted && failure.status === 404) onUnavailable?.(photo.id);
      });

    // Prepare authorization before the click so play() keeps browser activation.
    // The native player streams the original only when the guest presses Play.
    getGalleryPlayback(endpoint, photo.id, { uploadCode, signal: controller.signal })
      .then((ticket) => {
        if (controller.signal.aborted) return;
        setPlayback(ticket);
        setIsPreparing(false);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure.status === 404) onUnavailable?.(photo.id);
        setError(failure.message || 'We couldn’t prepare this video. Please try again.');
        setIsPreparing(false);
      });

    return () => {
      controller.abort();
      if (posterUrl) URL.revokeObjectURL(posterUrl);
      // Release the native stream when closing, retrying, or changing memories.
      media?.pause();
      media?.removeAttribute('src');
      media?.load();
    };
  }, [endpoint, uploadCode, photo.id, onUnavailable, attempt]);

  function failPlayback() {
    if (!video.current?.getAttribute('src')) return;
    video.current.pause();
    setIsStarted(false);
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
      // Reveal the already-authorized element within this same user gesture.
      media.hidden = false;
      media.controls = true;
      const started = media.play();
      started?.catch(failPlayback);
    } catch { failPlayback(); }
  }

  return (
    <div className="guestVideoPlayer">
      {!isStarted && (poster
        ? <img className="guestVideoPoster" src={poster} alt="A wedding video shared by a guest" onError={() => setPoster('')} />
        : <div className="guestPhotoPlaceholder"><Video size={40} strokeWidth={1.3} aria-hidden="true" /></div>)}
      <video
        className="guestVideoMedia"
        controls={isStarted}
        crossOrigin="anonymous"
        hidden={!isStarted}
        onError={failPlayback}
        onLoadedData={() => setIsBuffering(false)}
        onPause={() => setIsBuffering(false)}
        onPlaying={() => setIsBuffering(false)}
        onWaiting={() => setIsBuffering(true)}
        playsInline
        poster={poster || undefined}
        preload="none"
        ref={video}
        src={playback?.url}
      >
        Your browser does not support video playback.
      </video>
      {!isStarted && !error && <button aria-label={isPreparing ? 'Preparing video' : 'Play video'} className="guestVideoPlay" disabled={isPreparing} onClick={play} type="button">
        {isPreparing ? <LoaderCircle className="memorySpinner" size={29} aria-hidden="true" /> : <Play size={31} fill="currentColor" aria-hidden="true" />}
      </button>}
      {isBuffering && isStarted && <span className="guestVideoBuffering" role="status"><LoaderCircle className="memorySpinner" size={28} aria-hidden="true" /><span className="srOnly">Loading video…</span></span>}
      {error && <div className="guestVideoError" role="alert"><p>{error}</p><button className="button secondary" onClick={() => setAttempt((current) => current + 1)} type="button"><RotateCw size={16} aria-hidden="true" /> Try again</button></div>}
    </div>
  );
}
