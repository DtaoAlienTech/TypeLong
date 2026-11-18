// Minimal animated line chart (WPM over time) on a canvas. No libraries.
import { REDUCED } from "./fx.js";

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{label:string,color:string,values:number[]}[]} series  values[i] = WPM at second i+1
 */
export function drawChart(canvas, series, { animate = true, xLabel = (i) => `${i + 1}s` } = {}) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 220;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  const pad = { l: 42, r: 14, t: 12, b: 26 };
  const W = cssW - pad.l - pad.r;
  const H = cssH - pad.t - pad.b;
  const n = Math.max(2, ...series.map((s) => s.values.length));
  const peak = Math.max(20, ...series.flatMap((s) => s.values));
  const yMax = Math.ceil((peak * 1.15) / 10) * 10;

  const X = (i) => pad.l + (n === 1 ? 0 : (i / (n - 1)) * W);
  const Y = (v) => pad.t + H - (v / yMax) * H;

  const render = (k) => {
    g.clearRect(0, 0, cssW, cssH);
    g.font = "11px 'JetBrains Mono', ui-monospace, monospace";
    g.textBaseline = "middle";

    // grid + y labels
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = (yMax / 4) * i;
      const y = Math.round(Y(v)) + 0.5;
      g.strokeStyle = "rgba(128,137,192,0.18)";
      g.beginPath();
      g.moveTo(pad.l, y);
      g.lineTo(pad.l + W, y);
      g.stroke();
      g.fillStyle = "#8089C0";
      g.textAlign = "right";
      g.fillText(String(Math.round(v)), pad.l - 8, y);
    }
    // x labels (seconds)
    g.textAlign = "center";
    g.textBaseline = "top";
    const step = Math.max(1, Math.ceil(n / 8));
    for (let i = 0; i < n; i += step) {
      g.fillStyle = "#8089C0";
      g.fillText(xLabel(i), X(i), pad.t + H + 8);
    }

    // clip to animated width
    g.save();
    g.beginPath();
    g.rect(0, 0, pad.l + W * k + 2, cssH);
    g.clip();

    for (const s of series) {
      if (!s.values.length) continue;
      g.lineJoin = "round";
      g.lineCap = "round";
      // glow
      g.shadowColor = s.color;
      g.shadowBlur = 12;
      g.strokeStyle = s.color;
      g.lineWidth = 2.5;
      g.beginPath();
      s.values.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
      g.stroke();
      g.shadowBlur = 0;
      // soft area fill
      const grad = g.createLinearGradient(0, pad.t, 0, pad.t + H);
      grad.addColorStop(0, s.color + "33");
      grad.addColorStop(1, s.color + "00");
      g.fillStyle = grad;
      g.beginPath();
      s.values.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
      g.lineTo(X(s.values.length - 1), pad.t + H);
      g.lineTo(X(0), pad.t + H);
      g.closePath();
      g.fill();
      // end dot
      const last = s.values.length - 1;
      g.fillStyle = s.color;
      g.beginPath();
      g.arc(X(last), Y(s.values[last]), 3.5, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  };

  if (!animate || REDUCED) {
    render(1);
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 900);
    render(1 - Math.pow(1 - k, 3));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
