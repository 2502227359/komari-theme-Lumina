import { formatBytes } from "@/utils/format";

export type TrafficLimitKind = "sum" | "up" | "down" | "max" | "min";

export interface TrafficUsage {
  up: number;
  down: number;
  used: number;
  limit: number;
  hasLimit: boolean;
  ratio: number;
  progressRatio: number;
  percent: number;
  kind: TrafficLimitKind;
  kindLabel: string;
}

function finiteBytes(value: number | undefined | null) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function normalizeTrafficLimitKind(kind: string | undefined | null): TrafficLimitKind {
  const normalized = String(kind ?? "").trim().toLowerCase();
  if (
    normalized === "sum" ||
    normalized === "up" ||
    normalized === "down" ||
    normalized === "max" ||
    normalized === "min"
  ) {
    return normalized;
  }
  return "sum";
}

export function getTrafficLimitKindLabel(kind: string | undefined | null) {
  switch (normalizeTrafficLimitKind(kind)) {
    case "up":
      return "按上行";
    case "down":
      return "按下行";
    case "max":
      return "按较大方向";
    case "min":
      return "按较小方向";
    case "sum":
    default:
      return "按上下行总和";
  }
}

export function resolveTrafficUsed(
  up: number | undefined | null,
  down: number | undefined | null,
  kind: string | undefined | null,
) {
  const safeUp = finiteBytes(up);
  const safeDown = finiteBytes(down);
  const normalizedKind = normalizeTrafficLimitKind(kind);

  switch (normalizedKind) {
    case "up":
      return safeUp;
    case "down":
      return safeDown;
    case "max":
      return Math.max(safeUp, safeDown);
    case "min":
      return Math.min(safeUp, safeDown);
    case "sum":
    default:
      return safeUp + safeDown;
  }
}

export function getTrafficUsage({
  up,
  down,
  limit,
  kind,
}: {
  up: number | undefined | null;
  down: number | undefined | null;
  limit: number | undefined | null;
  kind: string | undefined | null;
}): TrafficUsage {
  const safeUp = finiteBytes(up);
  const safeDown = finiteBytes(down);
  const safeLimit = finiteBytes(limit);
  const normalizedKind = normalizeTrafficLimitKind(kind);
  const used = resolveTrafficUsed(safeUp, safeDown, normalizedKind);
  const hasLimit = safeLimit > 0;
  const ratio = hasLimit ? used / safeLimit : 0;
  const progressRatio = Math.max(0, Math.min(1, ratio));

  return {
    up: safeUp,
    down: safeDown,
    used,
    limit: safeLimit,
    hasLimit,
    ratio,
    progressRatio,
    percent: ratio * 100,
    kind: normalizedKind,
    kindLabel: getTrafficLimitKindLabel(normalizedKind),
  };
}

export function formatTrafficPercent(percent: number) {
  if (!Number.isFinite(percent) || percent <= 0) return "0%";
  if (percent >= 100) return `${percent.toFixed(1)}%`;
  if (percent >= 10) return `${percent.toFixed(1)}%`;
  return `${percent.toFixed(2)}%`;
}

export function formatTrafficLimitSummary(usage: TrafficUsage) {
  if (!usage.hasLimit) return "未设置流量限额";
  return `${formatTrafficPercent(usage.percent)} · ${formatBytes(usage.used)} / ${formatBytes(usage.limit)} · ${usage.kindLabel}`;
}
