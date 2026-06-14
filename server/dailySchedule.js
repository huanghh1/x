export function nextDailyRunAt(hour, now = new Date()) {
  const next = new Date(now);
  next.setHours(Math.max(0, Math.min(23, Number(hour) || 0)), 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}
