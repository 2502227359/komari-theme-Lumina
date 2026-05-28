import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
} from "react";
import UplotReact from "uplot-react";
import type uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { ArrowDown, ArrowUp, Gauge, Info, Network } from "lucide-react";
import { useLoadRecords } from "@/hooks/useRecords";
import { useNode } from "@/hooks/useNode";
import { usePreferences } from "@/hooks/usePreferences";
import { formatBytes } from "@/utils/format";
import {
  formatTrafficLimitSummary,
  formatTrafficPercent,
  getTrafficUsage,
  resolveTrafficUsed,
} from "@/utils/traffic";
import type { NodeDisplay } from "@/types/komari";
import { InstancePanel } from "./InstancePanel";
import {
  createTimeAxisFormatter,
  formatChartCoverageTime,
  formatTooltipTime,
  getChartTooltipPosition,
  toChartSeconds,
  useResponsiveChartSize,
} from "./chartShared";

const TRAFFIC_COLORS = {
  used: "#5d88ff",
  up: "#a35cf5",
  down: "#61c08f",
} as const;

const TRAFFIC_KEYS = ["used", "up", "down"];
const TRAFFIC_SAMPLE_INTERVAL_SECONDS = 5 * 60;

interface TrafficPoint {
  time: number;
  used: number | null;
  up: number | null;
  down: number | null;
  rateUp?: number | null;
  rateDown?: number | null;
  [key: string]: number | null | undefined;
}

interface TooltipState {
  show: boolean;
  left: number;
  top: number;
  rows: Array<{ label: string; value: string; color: string }>;
  time: string;
}

function trafficData(points: TrafficPoint[]): uPlot.AlignedData {
  return [
    points.map((point) => point.time),
    points.map((point) => point.used),
    points.map((point) => point.up),
    points.map((point) => point.down),
  ] as uPlot.AlignedData;
}

function formatRangeSummary(hours: number) {
  if (hours === 0) return "实时";
  if (hours % 24 === 0) return `${hours / 24} 天`;
  return `${hours} 小时`;
}

function pointFromNode(node: NodeDisplay): TrafficPoint {
  return {
    time: Date.now() / 1000,
    used: resolveTrafficUsed(node.trafficUp, node.trafficDown, node.traffic_limit_type),
    up: node.trafficUp,
    down: node.trafficDown,
    rateUp: node.netUp,
    rateDown: node.netDown,
  };
}

function currentUsageKind(limit: number | undefined | null, kind: string) {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? kind : "sum";
}

function toIntervalTrafficPoints(points: TrafficPoint[], limitKind: string) {
  return points.map((point) => {
    const rateUp =
      typeof point.rateUp === "number" && Number.isFinite(point.rateUp)
        ? Math.max(0, point.rateUp)
        : null;
    const rateDown =
      typeof point.rateDown === "number" && Number.isFinite(point.rateDown)
        ? Math.max(0, point.rateDown)
        : null;
    const upDelta = rateUp == null ? null : rateUp * TRAFFIC_SAMPLE_INTERVAL_SECONDS;
    const downDelta = rateDown == null ? null : rateDown * TRAFFIC_SAMPLE_INTERVAL_SECONDS;

    return {
      time: point.time,
      used:
        upDelta == null && downDelta == null
          ? null
          : resolveTrafficUsed(upDelta ?? 0, downDelta ?? 0, limitKind),
      up: upDelta,
      down: downDelta,
    };
  });
}

function sumPointValues(points: TrafficPoint[], key: keyof Pick<TrafficPoint, "used" | "up" | "down">) {
  return points.reduce((sum, point) => {
    const value = point[key];
    return typeof value === "number" && Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

function getSeriesLabel(key: string, usedLabel: string) {
  if (key === "used") return usedLabel;
  if (key === "up") return "上行估算 5 分钟用量";
  if (key === "down") return "下行估算 5 分钟用量";
  return key;
}

function formatAxisBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return formatBytes(value, 1);
}

function buildOptions({
  width,
  height,
  resolvedAppearance,
  rangeHours,
  usedLabel,
  chartRef,
  setTooltip,
}: {
  width: number;
  height: number;
  resolvedAppearance: "light" | "dark";
  rangeHours: number;
  usedLabel: string;
  chartRef: MutableRefObject<uPlot.AlignedData>;
  setTooltip: Dispatch<SetStateAction<TooltipState>>;
}): uPlot.Options {
  const isDark = resolvedAppearance === "dark";
  const grid = isDark ? "rgba(255,255,255,0.065)" : "rgba(0,0,0,0.08)";
  const text = isDark ? "#a5a5aa" : "#52525b";
  const colors = [TRAFFIC_COLORS.used, TRAFFIC_COLORS.up, TRAFFIC_COLORS.down];

  return {
    width,
    height,
    padding: [10, 14, 12, 2],
    cursor: { drag: { x: true, y: false } },
    legend: { show: false },
    scales: { x: { time: true }, y: { auto: true } },
    axes: [
      {
        stroke: text,
        grid: { stroke: grid, width: 1 },
        ticks: { stroke: grid },
        size: rangeHours >= 72 ? 38 : 34,
        values: createTimeAxisFormatter(rangeHours),
      },
      {
        stroke: text,
        grid: { stroke: grid, width: 1 },
        ticks: { stroke: grid },
        size: 76,
        values: (_self, splits) => splits.map(formatAxisBytes),
      },
    ],
    series: [
      { label: "time" },
      ...TRAFFIC_KEYS.map((key, index) => ({
        label: getSeriesLabel(key, usedLabel),
        stroke: colors[index],
        fill: index === 0 ? `${colors[index]}22` : undefined,
        width: index === 0 ? 1.9 : 1.55,
        spanGaps: false,
        points: { show: false },
      })),
    ],
    hooks: {
      init: [
        (u) => {
          u.root.setAttribute("aria-label", "流量使用增量");
          u.root.addEventListener("mouseleave", () => {
            setTooltip((prev) => ({ ...prev, show: false }));
          });
        },
      ],
      setCursor: [
        (u) => {
          const idx = u.cursor.idx;
          if (idx == null || idx < 0) {
            setTooltip((prev) => ({ ...prev, show: false }));
            return;
          }

          const currentData = chartRef.current;
          const timestamp = currentData[0]?.[idx];
          if (typeof timestamp !== "number") {
            setTooltip((prev) => ({ ...prev, show: false }));
            return;
          }

          const bbox = u.root.getBoundingClientRect();
          const anchorX = u.valToPos(timestamp, "x");
          const anchorY = typeof u.cursor.top === "number" ? u.cursor.top : bbox.height * 0.5;
          const rows = TRAFFIC_KEYS.map((key, index) => {
            const value = currentData[index + 1]?.[idx] as number | null | undefined;
            return {
              label: getSeriesLabel(key, usedLabel),
              value: value == null ? "—" : formatBytes(value),
              color: colors[index],
            };
          });
          const position = getChartTooltipPosition({
            containerWidth: bbox.width,
            containerHeight: bbox.height,
            anchorX,
            anchorY,
            rowCount: rows.length,
            estimatedWidth: 196,
          });
          setTooltip({
            show: true,
            left: position.left,
            top: position.top,
            rows,
            time: formatTooltipTime(timestamp, rangeHours),
          });
        },
      ],
    },
  };
}

export function TrafficChart({
  uuid,
  hours,
  active = true,
}: {
  uuid: string;
  hours: number;
  active?: boolean;
}) {
  const queryHours = hours === 0 ? 1 : hours;
  const { data, isLoading } = useLoadRecords(uuid, queryHours, active);
  const node = useNode(uuid, active);
  const { resolvedAppearance } = usePreferences();
  const { w, h } = useResponsiveChartSize("wide");
  const chartRef = useRef<uPlot.AlignedData>([[]]);
  const [tooltip, setTooltip] = useState<TooltipState>({
    show: false,
    left: 0,
    top: 0,
    rows: [],
    time: "",
  });

  const limitKind = node?.traffic_limit_type ?? "sum";

  const historyPoints = useMemo<TrafficPoint[]>(() => {
    const records = [...(data?.records ?? [])];
    return records
      .map((record) => ({
        time: toChartSeconds(record.time),
        used: resolveTrafficUsed(record.net_total_up, record.net_total_down, limitKind),
        up: record.net_total_up,
        down: record.net_total_down,
        rateUp: record.net_out,
        rateDown: record.net_in,
      }))
      .filter((point) => point.time > 0)
      .sort((a, b) => a.time - b.time);
  }, [data, limitKind]);

  const points = historyPoints;
  const usageKind = currentUsageKind(node?.traffic_limit, limitKind);

  const intervalPoints = useMemo(
    () => toIntervalTrafficPoints(points, usageKind),
    [points, usageKind],
  );
  const chart = useMemo(() => trafficData(intervalPoints), [intervalPoints]);

  useEffect(() => {
    chartRef.current = chart;
  }, [chart]);

  const latest = node ? pointFromNode(node) : points[points.length - 1];
  const currentUsage = getTrafficUsage({
    up: latest?.up,
    down: latest?.down,
    limit: node?.traffic_limit,
    kind: usageKind,
  });
  const periodUp = sumPointValues(intervalPoints, "up");
  const periodDown = sumPointValues(intervalPoints, "down");
  const periodUsed = sumPointValues(intervalPoints, "used");
  const currentUsedLabel = currentUsage.hasLimit ? `限额用量（${currentUsage.kindLabel}）` : "总用量";
  const usedLabel = currentUsage.hasLimit ? `限额估算 5 分钟用量（${currentUsage.kindLabel}）` : "总流量估算 5 分钟用量";
  const sourceRecordCount = data?.records.length ?? 0;
  const sampleSummary = `${points.length} / ${sourceRecordCount} 个 5 分钟采样点`;
  const coverageSummary = points.length
    ? `${formatChartCoverageTime(points[0].time)} - ${formatChartCoverageTime(points[points.length - 1].time)}`
    : "—";
  const rangeSummary = formatRangeSummary(hours);
  const options = useMemo(
    () =>
      buildOptions({
        width: w,
        height: h,
        resolvedAppearance,
        rangeHours: hours,
        usedLabel,
        chartRef,
        setTooltip,
      }),
    [h, hours, resolvedAppearance, usedLabel, w],
  );

  if (isLoading) {
    return <section className="instance-panel h-[260px] animate-pulse" aria-busy />;
  }

  if (!points.length) {
    return (
      <InstancePanel title="流量图表">
        <div className="instance-empty">暂无流量历史数据</div>
      </InstancePanel>
    );
  }

  return (
    <InstancePanel
      title="流量图表"
      description={coverageSummary}
      aside={<span className="instance-chart-range-chip">{rangeSummary}</span>}
      className="instance-chart-panel"
    >
      <div className="instance-chart-toolbar">
        <div className="instance-chart-meta" aria-label="流量图表数据范围">
          <span>
            覆盖 <strong>{coverageSummary}</strong>
          </span>
          <span>
            采样 <strong>{sampleSummary}</strong>
          </span>
          <span>
            本段新增 <strong>{formatBytes(periodUsed)}</strong>
          </span>
        </div>
        <p className="instance-chart-data-note">
          <Info size={13} />
          <span>按实时速率估算每个 5 分钟采样点，历史缺口取决于后端记录保留。</span>
        </p>
      </div>

      <div className="instance-overview-grid instance-traffic-summary-grid">
        <TrafficSummaryItem
          icon={<Network size={13} />}
          label="当前总流量"
          value={formatBytes(currentUsage.up + currentUsage.down)}
          note={`${currentUsedLabel} ${formatBytes(currentUsage.used)}`}
          color={TRAFFIC_COLORS.used}
        />
        <TrafficSummaryItem
          icon={<ArrowUp size={13} />}
          label="上行累计"
          value={formatBytes(currentUsage.up)}
          note={`本段新增 ${formatBytes(periodUp)}`}
          color={TRAFFIC_COLORS.up}
        />
        <TrafficSummaryItem
          icon={<ArrowDown size={13} />}
          label="下行累计"
          value={formatBytes(currentUsage.down)}
          note={`本段新增 ${formatBytes(periodDown)}`}
          color={TRAFFIC_COLORS.down}
        />
        <TrafficSummaryItem
          icon={<Gauge size={13} />}
          label="限额占比"
          value={currentUsage.hasLimit ? formatTrafficPercent(currentUsage.percent) : "未设置"}
          note={formatTrafficLimitSummary(currentUsage)}
          color={TRAFFIC_COLORS.used}
          progress={currentUsage.hasLimit ? currentUsage.progressRatio : undefined}
        />
      </div>

      <div
        className="instance-chart-card instance-traffic-chart-card"
        style={{ "--chart-accent": TRAFFIC_COLORS.used } as CSSProperties}
      >
        <header className="instance-chart-card-head">
          <div className="instance-panel-subhead">
            <Network size={13} />
            <span>时间段流量</span>
          </div>
          <div className="instance-series-stats">
            <span className="tabular">{formatBytes(periodUsed)}</span>
            <span className="tabular text-[var(--text-tertiary)]">
              按速率估算每 5 分钟
            </span>
          </div>
        </header>
        <div className="instance-uplot-wrap is-large">
          <UplotReact options={options} data={chart} />
          {tooltip.show && (
            <div
              className="instance-chart-tooltip"
              style={{ left: tooltip.left, top: tooltip.top }}
            >
              <div className="instance-chart-tooltip-time">{tooltip.time}</div>
              {tooltip.rows.map((row) => (
                <div key={`${row.label}-${row.color}`} className="instance-chart-tooltip-row">
                  <span className="instance-chart-tooltip-dot" style={{ background: row.color }} />
                  <span>{row.label}</span>
                  <strong>{row.value}</strong>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </InstancePanel>
  );
}

function TrafficSummaryItem({
  icon,
  label,
  value,
  note,
  color,
  progress,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  note: string;
  color: string;
  progress?: number;
}) {
  return (
    <div className="instance-overview-item instance-traffic-summary-item">
      <div className="instance-panel-subhead" style={{ color }}>
        {icon}
        <span>{label}</span>
      </div>
      <div className="instance-overview-value tabular">{value}</div>
      {progress != null && (
        <div className="instance-progress-track" aria-hidden>
          <span
            className="instance-progress-fill"
            style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }}
          />
        </div>
      )}
      <div className="instance-overview-note">{note}</div>
    </div>
  );
}
