export function formatDuration(ms: number): string {
  if (ms === 0) {
    return "0ms";
  }

  const sign = ms < 0 ? "-" : "";
  const absMs = Math.abs(ms);

  if (absMs < 1000) {
    const roundedMs = Math.round(absMs);
    if (roundedMs >= 1000) {
      return `${sign}1s`;
    }
    return `${sign}${roundedMs}ms`;
  }

  const totalSeconds = absMs / 1000;
  if (totalSeconds < 60) {
    const roundedSeconds = Math.round(totalSeconds * 10) / 10;
    if (roundedSeconds >= 60) {
      return `${sign}1m`;
    }
    const compact = roundedSeconds.toFixed(1).replace(/\.0$/, "");
    return `${sign}${compact}s`;
  }

  if (totalSeconds < 3600) {
    let minutes = Math.floor(totalSeconds / 60);
    let seconds = Math.round(totalSeconds - minutes * 60);

    if (seconds === 60) {
      minutes += 1;
      seconds = 0;
    }

    if (minutes >= 60) {
      return `${sign}1h 0m`;
    }

    if (seconds === 0) {
      return `${sign}${minutes}m`;
    }

    return `${sign}${minutes}m ${seconds}s`;
  }

  const totalMinutes = absMs / 60000;
  if (totalMinutes < 24 * 60) {
    let hours = Math.floor(totalMinutes / 60);
    let minutes = Math.round(totalMinutes - hours * 60);

    if (minutes === 60) {
      hours += 1;
      minutes = 0;
    }

    if (hours >= 24) {
      return `${sign}1d 0h`;
    }

    return `${sign}${hours}h ${minutes}m`;
  }

  const totalHours = absMs / 3600000;
  let days = Math.floor(totalHours / 24);
  let hours = Math.round(totalHours - days * 24);

  if (hours === 24) {
    days += 1;
    hours = 0;
  }

  return `${sign}${days}d ${hours}h`;
}
