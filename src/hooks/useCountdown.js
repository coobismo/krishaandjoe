import { useMemo } from 'react';
import { WEDDING_DATE } from '../data/wedding.js';

const DAY_IN_MS = 1000 * 60 * 60 * 24;

export function useCountdown(targetDate = WEDDING_DATE) {
  return useMemo(() => {
    const diff = targetDate.getTime() - Date.now();

    if (diff <= 0) {
      return { days: 0, label: 'Today is the day' };
    }

    const days = Math.ceil(diff / DAY_IN_MS);
    return { days, label: `${days} days to go` };
  }, [targetDate]);
}
