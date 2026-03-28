import { useState, useEffect, useRef } from 'react';

export function useElapsedTime(startTime: number, running: boolean): number {
  const [elapsedMs, setElapsedMs] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startTime);
      }, 100);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [running, startTime]);

  return elapsedMs;
}
