import { useEffect, useState } from 'react';
import { WEDDING_DATE } from '../data/wedding.js';

const SECOND_IN_MS = 1000;

export function useCountdown(targetDate = WEDDING_DATE) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(intervalId);
  }, []);

  const diff = targetDate.getTime() - now;

  if (diff <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, isComplete: true, label: 'Today is the day' };
  }

  const totalSeconds = Math.ceil(diff / SECOND_IN_MS);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const seconds = totalSeconds % 60;
  const label = [
    `${days} ${days === 1 ? 'day' : 'days'}`,
    `${hours} ${hours === 1 ? 'hour' : 'hours'}`,
    `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`,
    `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`,
  ].join(' ');

  return { days, hours, minutes, seconds, isComplete: false, label: `${label} to go` };
}
