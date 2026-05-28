import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { InstanceDetails } from "@/components/instance/InstanceDetails";
import { PingChart } from "@/components/instance/PingChart";
import { LoadChart } from "@/components/instance/LoadChart";
import { TrafficChart } from "@/components/instance/TrafficChart";
import {
  buildLoadTimeRangeOptions,
} from "@/components/instance/chartShared";
import { usePublicConfig } from "@/hooks/usePublicConfig";

const FIXED_PING_HOURS = 24;

export function Instance() {
  const { uuid } = useParams<{ uuid: string }>();
  const { data: config } = usePublicConfig();
  const [chartType, setChartType] = useState<"load" | "traffic" | "ping">("load");
  const [loadHours, setLoadHours] = useState(0);
  const chartControlsRef = useRef<HTMLDivElement | null>(null);

  const loadRanges = useMemo(
    () => buildLoadTimeRangeOptions(config?.record_preserve_time),
    [config?.record_preserve_time],
  );
  const showPingChart = config?.theme_settings?.showPingChart !== false;

  const alignCharts = () => {
    const frame = window.requestAnimationFrame(() => {
      chartControlsRef.current?.scrollIntoView({
        behavior: "auto",
        block: "start",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  };

  useEffect(() => {
    return alignCharts();
  }, [uuid]);

  useEffect(() => {
    if (!loadRanges.some((range) => range.value === loadHours)) {
      setLoadHours(loadRanges[0]?.value ?? 0);
    }
  }, [loadHours, loadRanges]);

  useEffect(() => {
    if (!showPingChart && chartType === "ping") {
      setChartType("load");
    }
  }, [chartType, showPingChart]);

  if (!uuid) return null;

  return (
    <div className="flex flex-col gap-5 py-2">
      <Link
        to="/"
        className="instance-page-back"
      >
        <ChevronLeft size={14} />
        返回
      </Link>
      <InstanceDetails uuid={uuid} onNodeReady={alignCharts} />
      <div ref={chartControlsRef} className="instance-chart-controls">
        <div className="instance-segmented">
          <button
            type="button"
            data-active={chartType === "load" ? "true" : "false"}
            onClick={() => {
              startTransition(() => setChartType("load"));
            }}
          >
            负载
          </button>
          <button
            type="button"
            data-active={chartType === "traffic" ? "true" : "false"}
            onClick={() => {
              startTransition(() => setChartType("traffic"));
            }}
          >
            流量
          </button>
          {showPingChart && (
            <button
              type="button"
              data-active={chartType === "ping" ? "true" : "false"}
              onClick={() => {
                startTransition(() => setChartType("ping"));
              }}
            >
              Ping
            </button>
          )}
        </div>
        {(chartType === "load" || chartType === "traffic") && (
          <div
            key={`${chartType}-ranges`}
            className="instance-segmented is-scrollable"
          >
            {loadRanges.map((range) => (
              <button
                key={range.value}
                type="button"
                data-active={loadHours === range.value ? "true" : "false"}
                onClick={() => {
                  startTransition(() => {
                    setLoadHours(range.value);
                  });
                }}
              >
                {range.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="instance-chart-stage">
        <div
          className="instance-chart-view"
          hidden={chartType !== "load"}
          aria-hidden={chartType !== "load"}
        >
          <LoadChart uuid={uuid} hours={loadHours} active={chartType === "load"} />
        </div>
        <div
          className="instance-chart-view"
          hidden={chartType !== "traffic"}
          aria-hidden={chartType !== "traffic"}
        >
          <TrafficChart
            uuid={uuid}
            hours={loadHours}
            active={chartType === "traffic"}
          />
        </div>
        <div
          className="instance-chart-view"
          hidden={chartType !== "ping"}
          aria-hidden={chartType !== "ping"}
        >
          {showPingChart ? (
            <PingChart
              uuid={uuid}
              hours={FIXED_PING_HOURS}
              active={chartType === "ping"}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
