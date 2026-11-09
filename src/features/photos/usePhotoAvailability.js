import { useEffect, useState } from 'react';
import { isPhotoAreaVisible, PHOTO_RELEASE_AT } from './photoAvailability.mjs';

export function usePhotoAvailability() {
  const evaluate = () => isPhotoAreaVisible({ search: typeof window === 'undefined' ? '' : window.location.search });
  const [isVisible, setIsVisible] = useState(evaluate);

  useEffect(() => {
    let timer;
    function update() {
      clearTimeout(timer);
      setIsVisible(evaluate());
      const remaining = Date.parse(PHOTO_RELEASE_AT) - Date.now();
      if (remaining > 0) timer = setTimeout(update, Math.min(remaining + 100, 2_147_483_647));
    }
    update();
    window.addEventListener('popstate', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('popstate', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  return isVisible;
}
