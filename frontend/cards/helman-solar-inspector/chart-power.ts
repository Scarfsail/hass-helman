export type PowerPoint = { timestamp: string; valueWh: number };
export type ChartEntry<TPoint extends PowerPoint = PowerPoint> = {
  point: TPoint;
  minutes: number;
  powerW: number;
};

type AveragePowerOptions = {
  bucketMinutes?: number;
};

export function toAveragePower<TPoint extends PowerPoint>(
  points: TPoint[],
  options: AveragePowerOptions = {},
): ChartEntry<TPoint>[] {
  const parsed = points
    .map((point) => ({ point, minutes: pointMinutes(point.timestamp) }))
    .filter(
      (entry): entry is { point: TPoint; minutes: number } =>
        entry.minutes !== null && Number.isFinite(entry.point.valueWh),
    )
    .sort((a, b) => a.minutes - b.minutes);

  if (parsed.length === 0) return [];

  const fixedBucketMinutes = options.bucketMinutes;
  if (fixedBucketMinutes !== undefined) {
    const hours = fixedBucketMinutes / 60;
    return parsed.map((entry) => ({
      point: entry.point,
      minutes: entry.minutes,
      powerW: hours > 0 ? entry.point.valueWh / hours : 0,
    }));
  }

  const gaps: number[] = [];
  for (let i = 0; i < parsed.length - 1; i++) {
    gaps.push(parsed[i + 1].minutes - parsed[i].minutes);
  }
  const fallbackGap = parsed.length === 1 ? 60 : gaps[gaps.length - 1] ?? 60;

  return parsed.map((entry, index) => {
    const gap = index < gaps.length ? gaps[index] : fallbackGap;
    const hours = gap / 60;
    const powerW = hours > 0 ? entry.point.valueWh / hours : 0;
    return { point: entry.point, minutes: entry.minutes, powerW };
  });
}

function pointMinutes(timestamp: string): number | null {
  const match = timestamp.match(/T(\d{2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  return hour * 60 + minute;
}
