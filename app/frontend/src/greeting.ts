/** Uses the user's local system time. */
export function greetingForTime(date: Date): string {
  const hour = date.getHours();
  if (hour >= 5 && hour < 11) return '早上好';
  if (hour >= 11 && hour < 13) return '中午好';
  if (hour >= 13 && hour < 18) return '下午好';
  return '晚上好';
}
