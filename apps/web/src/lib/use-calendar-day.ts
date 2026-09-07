import { useEffect, useState } from 'react';
import { calendarDay, untilNextDay } from './calendar-day.js';

export function useCalendarDay(): string {
  const [day, setDay] = useState(calendarDay);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      setDay(calendarDay());
      clearTimeout(timer);
      timer = setTimeout(refresh, untilNextDay() + 100);
    };
    timer = setTimeout(refresh, untilNextDay() + 100);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return day;
}
