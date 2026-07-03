'use client';

import { format } from 'date-fns';
import { useCallback, useEffect, useId, useState } from 'react';
import {
  Brush,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export default function Home() {
  const startTimeId = useId();
  const endTimeId = useId();

  const [chains, setChains] = useState<string[]>(['All']);
  const [regions, setRegions] = useState<string[]>(['All']);
  const [selectedChain, setSelectedChain] = useState('All');
  const [selectedRegion, setSelectedRegion] = useState('All');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [loading, setLoading] = useState(false);
  const [chartData, setChartData] = useState<any[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [hoursToShow, setHoursToShow] = useState(24);

  // Smart clean state
  const [smartThreshold, setSmartThreshold] = useState(5);
  const [smartHours, setSmartHours] = useState(24);
  const [smartCleanLoading, setSmartCleanLoading] = useState(false);
  const [smartCleanResults, setSmartCleanResults] = useState<any>(null);

  // Zoom state
  const [zoomDomain, setZoomDomain] = useState<[number, number] | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);

  // Selection state for click-and-drag
  const [refAreaLeft, setRefAreaLeft] = useState<number | null>(null);
  const [refAreaRight, setRefAreaRight] = useState<number | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);

  const buildLabels = useCallback(() => {
    const parts = ['aggregator="mobula"'];
    if (selectedChain !== 'All') parts.push(`chain="${selectedChain}"`);
    if (selectedRegion !== 'All') parts.push(`region="${selectedRegion}"`);
    return parts.join(',');
  }, [selectedChain, selectedRegion]);

  const loadChart = useCallback(async () => {
    setChartLoading(true);
    try {
      const labels = buildLabels();
      const res = await fetch('/api/chart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metric: 'head_lag_seconds', labels, hours: hoursToShow }),
      });
      const data = await res.json();
      setChartData(data.data || []);
    } catch (error) {
      console.error('Chart error:', error);
    }
    setChartLoading(false);
  }, [buildLabels, hoursToShow]);

  useEffect(() => {
    // Load available labels
    fetch('/api/labels')
      .then((res) => res.json())
      .then((data) => {
        if (data.chains) setChains(data.chains);
        if (data.regions) setRegions(data.regions);
      });
  }, []);

  useEffect(() => {
    loadChart();
  }, [loadChart]);

  const handleBrushChange = (domain: any) => {
    if (domain?.startIndex !== undefined && domain?.endIndex !== undefined) {
      const start = chartData[domain.startIndex]?.timestamp;
      const end = chartData[domain.endIndex]?.timestamp;

      if (start && end) {
        setStartTime(format(new Date(start), "yyyy-MM-dd'T'HH:mm:ss"));
        setEndTime(format(new Date(end), "yyyy-MM-dd'T'HH:mm:ss"));
      }
    }
  };

  const handleMouseDown = (e: any) => {
    if (e?.activeLabel) {
      setRefAreaLeft(e.activeLabel);
      setIsSelecting(true);
    }
  };

  const handleMouseMove = (e: any) => {
    if (isSelecting && e?.activeLabel) {
      setRefAreaRight(e.activeLabel);
    }
  };

  const handleMouseUp = (e: any) => {
    if (refAreaLeft && refAreaRight) {
      const start = Math.min(refAreaLeft, refAreaRight);
      const end = Math.max(refAreaLeft, refAreaRight);

      setStartTime(format(new Date(start), "yyyy-MM-dd'T'HH:mm:ss"));
      setEndTime(format(new Date(end), "yyyy-MM-dd'T'HH:mm:ss"));
    }

    setRefAreaLeft(null);
    setRefAreaRight(null);
    setIsSelecting(false);
  };

  const handleZoomToSelection = () => {
    if (!startTime || !endTime) return;

    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();

    setZoomDomain([start, end]);
    setZoomLevel(prev => prev + 1);
  };

  const handleResetZoom = () => {
    setZoomDomain(null);
    setZoomLevel(1);
  };

  const handleQuickClean = async () => {
    if (!startTime || !endTime) return;

    const startDate = new Date(startTime);
    const endDate = new Date(endTime);
    const startStr = startDate.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const endStr = endDate.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const startUTC = startDate.toISOString().slice(0, 19).replace('T', ' ');
    const endUTC = endDate.toISOString().slice(0, 19).replace('T', ' ');

    const labels = buildLabels();
    const confirmMsg = `Delete head_lag_seconds?\n\nFilters: ${labels}\nLocal: ${startStr} → ${endStr}\nUTC: ${startUTC} → ${endUTC}\n\n⚠️ Exact range (no margin)`;

    if (!confirm(confirmMsg)) return;

    setLoading(true);
    try {
      const labels = buildLabels();
      const res = await fetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startTime,
          endTime,
          metric: 'head_lag_seconds',
          labels,
        }),
      });
      const _data = await res.json();
      alert(`Timeline deleted ✓`);
      setStartTime('');
      setEndTime('');

      // Wait 2 seconds for Prometheus to finish cleaning tombstones
      await new Promise((resolve) => setTimeout(resolve, 2000));
      loadChart();
    } catch (error) {
      console.error('Delete error:', error);
      alert('❌ Error during deletion');
    }
    setLoading(false);
  };

  const handleSmartClean = async (dryRun: boolean) => {
    setSmartCleanLoading(true);
    setSmartCleanResults(null);

    try {
      const res = await fetch('/api/smart-clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threshold: smartThreshold,
          hours: smartHours,
          dryRun,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        alert(`❌ Smart clean failed: ${data.error ?? `HTTP ${res.status}`}`);
        setSmartCleanLoading(false);
        return;
      }
      setSmartCleanResults(data);

      if (!dryRun && data.deleted) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        loadChart();
      }
    } catch (error) {
      console.error('Smart clean error:', error);
      alert('❌ Error during smart clean');
    }
    setSmartCleanLoading(false);
  };

  return (
    <div
      style={{
        maxWidth: '1400px',
        margin: '30px auto',
        padding: '30px',
        background: '#0f1419',
        minHeight: '100vh',
        color: '#fff',
      }}
    >
      <div
        style={{
          background: '#1a1f2e',
          borderRadius: '12px',
          padding: '30px',
        }}
      >
        <h1 style={{ margin: '0 0 30px 0', fontSize: '28px', fontWeight: 600 }}>🗑️ Head Lag Cleaner - Mobula</h1>

        {/* Chain Filters */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', marginBottom: '10px', fontSize: '14px', color: '#888' }}>Chain</label>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            {chains.map((chain) => (
              <button
                key={chain}
                type="button"
                onClick={() => setSelectedChain(chain)}
                style={{
                  padding: '8px 16px',
                  background: selectedChain === chain ? '#0066ff' : '#1a1f2e',
                  color: '#fff',
                  border: selectedChain === chain ? '2px solid #0066ff' : '1px solid #333',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: selectedChain === chain ? 600 : 400,
                  transition: 'all 0.2s',
                }}
              >
                {chain}
              </button>
            ))}
          </div>
        </div>

        {/* Region Filters */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', marginBottom: '10px', fontSize: '14px', color: '#888' }}>Region</label>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            {regions.map((region) => (
              <button
                key={region}
                type="button"
                onClick={() => setSelectedRegion(region)}
                style={{
                  padding: '8px 16px',
                  background: selectedRegion === region ? '#0066ff' : '#1a1f2e',
                  color: '#fff',
                  border: selectedRegion === region ? '2px solid #0066ff' : '1px solid #333',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: selectedRegion === region ? 600 : 400,
                  transition: 'all 0.2s',
                }}
              >
                {region}
              </button>
            ))}
          </div>
        </div>

        {/* Time Range Selector */}
        <div style={{ marginBottom: '30px' }}>
          <label style={{ display: 'block', marginBottom: '10px', fontSize: '14px', color: '#888' }}>Time Range</label>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            {[6, 12, 24, 48, 72].map((hours) => (
              <button
                key={hours}
                type="button"
                onClick={() => setHoursToShow(hours)}
                style={{
                  padding: '8px 16px',
                  background: hoursToShow === hours ? '#0066ff' : '#1a1f2e',
                  color: '#fff',
                  border: hoursToShow === hours ? '2px solid #0066ff' : '1px solid #333',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: hoursToShow === hours ? 600 : 400,
                  transition: 'all 0.2s',
                }}
              >
                {hours}h
              </button>
            ))}
          </div>
        </div>

        {/* Chart */}
        <div
          style={{
            padding: '30px',
            background: '#0f1419',
            borderRadius: '8px',
            marginBottom: '30px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <div>
              <div>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 500 }}>
                  {selectedChain !== 'All' ? selectedChain : 'All Chains'}
                  {selectedRegion !== 'All' ? ` - ${selectedRegion}` : ''}
                </h3>
                <p style={{ margin: '5px 0 0 0', fontSize: '13px', color: '#888' }}>
                  Drag to select • Click "Zoom Here" to zoom on selection • Local timezone (UTC{new Date().getTimezoneOffset() > 0 ? '-' : '+'}{Math.abs(Math.floor(new Date().getTimezoneOffset() / 60))})
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              {zoomDomain && (
                <button
                  type="button"
                  onClick={handleResetZoom}
                  style={{
                    padding: '8px 16px',
                    background: '#666',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '13px',
                    fontWeight: 500,
                  }}
                >
                  ↺ Reset Zoom
                </button>
              )}
              {startTime && endTime && (
                <>
                  <div style={{ fontSize: '12px', color: '#888', marginRight: '10px' }}>
                    Selected: {format(new Date(startTime), 'HH:mm:ss')} → {format(new Date(endTime), 'HH:mm:ss')}
                  </div>
                  <button
                    type="button"
                    onClick={handleZoomToSelection}
                    style={{
                      padding: '8px 16px',
                      background: '#0088ff',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      fontWeight: 500,
                    }}
                  >
                    🔍 Zoom Here
                  </button>
                  <button
                    type="button"
                    onClick={handleQuickClean}
                    disabled={loading}
                    style={{
                      padding: '8px 16px',
                      background: '#ff3333',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      fontWeight: 600,
                      opacity: loading ? 0.5 : 1,
                    }}
                  >
                    🗑️ Clean
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={loadChart}
                disabled={chartLoading}
                style={{
                  padding: '8px 16px',
                  background: '#0066ff',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                  opacity: chartLoading ? 0.5 : 1,
                }}
              >
                {chartLoading ? 'Loading...' : 'Reload'}
              </button>
            </div>
          </div>

          {chartLoading ? (
            <div style={{ textAlign: 'center', padding: '100px', color: '#888' }}>Loading chart...</div>
          ) : chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={600}>
              <LineChart
                data={chartData}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  domain={zoomDomain || ['dataMin', 'dataMax']}
                  tickFormatter={(ts) => format(new Date(ts), 'HH:mm:ss')}
                  stroke="#888"
                  allowDataOverflow={true}
                />
                <YAxis stroke="#888" label={{ value: 'Lag (seconds)', angle: -90, position: 'insideLeft', style: { fill: '#888' } }} />
                <Tooltip
                  contentStyle={{ background: '#1a1f2e', border: '1px solid #333', borderRadius: '6px' }}
                  labelFormatter={(ts) => format(new Date(ts), 'yyyy-MM-dd HH:mm:ss')}
                  formatter={(value: any) => [value !== null && value !== undefined ? value.toFixed(3) : 'N/A', 'lag (s)']}
                  allowEscapeViewBox={{ x: true, y: true }}
                  isAnimationActive={false}
                />
                <Line type="monotone" dataKey="value" stroke="#00d4ff" dot={false} strokeWidth={2} connectNulls={false} />
                {refAreaLeft && refAreaRight && (
                  <ReferenceArea
                    x1={refAreaLeft}
                    x2={refAreaRight}
                    strokeOpacity={0.3}
                    fill="#ff3333"
                    fillOpacity={0.3}
                  />
                )}
                <Brush
                  dataKey="timestamp"
                  height={40}
                  stroke="#0066ff"
                  onChange={handleBrushChange}
                  tickFormatter={(ts) => format(new Date(ts), 'HH:mm')}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ textAlign: 'center', padding: '100px', color: '#888' }}>No data available</div>
          )}
        </div>

        {/* Time Selection */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '20px',
          }}
        >
          <div>
            <label
              htmlFor={startTimeId}
              style={{ display: 'block', marginBottom: '8px', fontSize: '14px', color: '#888' }}
            >
              Start Time (Local: UTC{new Date().getTimezoneOffset() > 0 ? '-' : '+'}{Math.abs(Math.floor(new Date().getTimezoneOffset() / 60))})
            </label>
            <input
              id={startTimeId}
              type="datetime-local"
              step="1"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              style={{
                width: '100%',
                padding: '10px',
                background: '#0f1419',
                color: '#fff',
                border: '1px solid #333',
                borderRadius: '6px',
                fontSize: '14px',
              }}
            />
            {startTime && (
              <p style={{ margin: '5px 0 0 0', fontSize: '12px', color: '#666' }}>
                UTC: {new Date(startTime).toISOString().replace('T', ' ').slice(0, 19)}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor={endTimeId}
              style={{ display: 'block', marginBottom: '8px', fontSize: '14px', color: '#888' }}
            >
              End Time (Local: UTC{new Date().getTimezoneOffset() > 0 ? '-' : '+'}{Math.abs(Math.floor(new Date().getTimezoneOffset() / 60))})
            </label>
            <input
              id={endTimeId}
              type="datetime-local"
              step="1"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              style={{
                width: '100%',
                padding: '10px',
                background: '#0f1419',
                color: '#fff',
                border: '1px solid #333',
                borderRadius: '6px',
                fontSize: '14px',
              }}
            />
            {endTime && (
              <p style={{ margin: '5px 0 0 0', fontSize: '12px', color: '#666' }}>
                UTC: {new Date(endTime).toISOString().replace('T', ' ').slice(0, 19)}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Smart Clean Section */}
      <div
        style={{
          background: '#1a1f2e',
          borderRadius: '12px',
          padding: '30px',
          marginTop: '30px',
        }}
      >
        <h2 style={{ margin: '0 0 20px 0', fontSize: '24px', fontWeight: 600 }}>⚡ Smart Clean - Auto Detect & Delete Spikes</h2>
        <p style={{ margin: '0 0 30px 0', fontSize: '14px', color: '#888' }}>
          Automatically detect and delete all spikes above a threshold across all regions and chains
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', color: '#888' }}>
              Threshold (seconds)
            </label>
            <input
              type="number"
              step="0.5"
              value={smartThreshold}
              onChange={(e) => setSmartThreshold(Number.parseFloat(e.target.value))}
              style={{
                width: '100%',
                padding: '10px',
                background: '#0f1419',
                color: '#fff',
                border: '1px solid #333',
                borderRadius: '6px',
                fontSize: '14px',
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', color: '#888' }}>
              Time Range (hours)
            </label>
            <input
              type="number"
              value={smartHours}
              onChange={(e) => setSmartHours(Number.parseInt(e.target.value))}
              style={{
                width: '100%',
                padding: '10px',
                background: '#0f1419',
                color: '#fff',
                border: '1px solid #333',
                borderRadius: '6px',
                fontSize: '14px',
              }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: '15px', marginBottom: '20px' }}>
          <button
            type="button"
            onClick={() => handleSmartClean(true)}
            disabled={smartCleanLoading}
            style={{
              padding: '12px 24px',
              background: '#0066ff',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 600,
              opacity: smartCleanLoading ? 0.5 : 1,
            }}
          >
            🔍 Preview (Dry Run)
          </button>
          <button
            type="button"
            onClick={() => handleSmartClean(false)}
            disabled={smartCleanLoading}
            style={{
              padding: '12px 24px',
              background: '#ff3333',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 600,
              opacity: smartCleanLoading ? 0.5 : 1,
            }}
          >
            🗑️ Smart Clean
          </button>
        </div>

        {smartCleanResults && (
          <div
            style={{
              padding: '20px',
              background: '#0f1419',
              borderRadius: '8px',
              border: '1px solid #333',
            }}
          >
            <div style={{ marginBottom: '15px' }}>
              <div style={{ fontSize: '14px', color: '#888', marginBottom: '10px' }}>
                {smartCleanResults.dryRun ? '🔍 Preview Results:' : '✅ Clean Results:'}
              </div>
              <div style={{ fontSize: '16px', fontWeight: 600 }}>
                Found {smartCleanResults.totalSpikes} spike points → grouped into {smartCleanResults.totalGroups} ranges
              </div>
              {!smartCleanResults.dryRun && (
                <div style={{ fontSize: '14px', color: '#0f0', marginTop: '5px' }}>
                  Deleted: {smartCleanResults.deleted} / Failed: {smartCleanResults.failed}
                </div>
              )}
            </div>

            {smartCleanResults.groups && smartCleanResults.groups.length > 0 && (
              <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
                <table style={{ width: '100%', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #333' }}>
                      <th style={{ padding: '8px', textAlign: 'left', color: '#888' }}>Region</th>
                      <th style={{ padding: '8px', textAlign: 'left', color: '#888' }}>Chain</th>
                      <th style={{ padding: '8px', textAlign: 'left', color: '#888' }}>Start</th>
                      <th style={{ padding: '8px', textAlign: 'left', color: '#888' }}>End</th>
                      <th style={{ padding: '8px', textAlign: 'left', color: '#888' }}>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {smartCleanResults.groups.map((group: any, idx: number) => (
                      <tr key={idx} style={{ borderBottom: '1px solid #222' }}>
                        <td style={{ padding: '8px' }}>{group.region}</td>
                        <td style={{ padding: '8px' }}>{group.chain}</td>
                        <td style={{ padding: '8px', color: '#888' }}>
                          {format(new Date(group.startTime), 'MM/dd HH:mm:ss')}
                        </td>
                        <td style={{ padding: '8px', color: '#888' }}>
                          {format(new Date(group.endTime), 'MM/dd HH:mm:ss')}
                        </td>
                        <td style={{ padding: '8px', color: '#888' }}>{group.duration}s</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
