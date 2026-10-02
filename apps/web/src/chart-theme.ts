// Canvas and SVG charts cannot read CSS variables reliably, so the chart
// palette mirrors the tokens in theme.css. Keep the two in sync.
export const chartTheme = {
  surface: "#0f1215",
  grid: "#161a20",
  axis: "#1d2229",
  text: "#5c6472",
  crosshair: "#4a525e",
  crosshairLabel: "#272d36",
  buy: "#26a69a",
  sell: "#ef5350",
  accent: "#8aa4d6",
  secondary: "#a596e8",
  font: '"Inter Variable", Inter, -apple-system, sans-serif',
} as const;

export const tooltipStyle = {
  background: "#14181d",
  border: "1px solid #272d36",
  borderRadius: 2,
  fontSize: 11.5,
  padding: "6px 9px",
} as const;
