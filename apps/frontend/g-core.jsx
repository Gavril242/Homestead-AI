// Gavirila v2 — tokens + theme system (light/dark) + liquid background

const G_THEMES = {
  dark: {
    bg: '#0a0410',
    bgDeep: '#060209',
    surface: 'rgba(30,14,52,.55)',
    panelBg: 'rgba(30,14,52,.55)',
    surface2: 'rgba(44,22,72,.4)',
    surfaceSolid: '#1a0d2e',
    surfaceRaised: 'rgba(58,30,96,.75)',
    border: 'rgba(216,180,254,.08)',
    borderStrong: 'rgba(216,180,254,.18)',
    borderHot: 'rgba(255,138,76,.3)',
    text: '#f8f0ff',
    textDim: 'rgba(230,210,250,.75)',
    textDimmer: 'rgba(200,180,230,.48)',
    textMuted: 'rgba(170,150,200,.32)',
    orange: '#ff8a4c',
    orangeHot: '#ff6a2a',
    orangeDeep: '#c93d1a',
    purple: '#b085ff',
    purpleDeep: '#7c3aed',
    pink: '#ec4899',
    green: '#6ee7b7',
    red: '#fca5a5',
    yellow: '#fcd34d',
    blue: '#93c5fd',
    chipBg: 'rgba(255,255,255,.04)',
    shadow: '0 8px 24px rgba(0,0,0,.4)',
  },
  light: {
    bg: '#fff9f3',
    bgDeep: '#fdf3e7',
    surface: 'rgba(255,255,255,.8)',
    panelBg: 'rgba(255,255,255,.8)',
    surface2: 'rgba(255,247,238,.7)',
    surfaceSolid: '#ffffff',
    surfaceRaised: 'rgba(255,255,255,.95)',
    border: 'rgba(201,100,66,.12)',
    borderStrong: 'rgba(201,100,66,.25)',
    borderHot: 'rgba(201,100,66,.4)',
    text: '#2a1509',
    textDim: 'rgba(60,32,14,.72)',
    textDimmer: 'rgba(80,48,22,.5)',
    textMuted: 'rgba(100,68,40,.32)',
    orange: '#ea5a1c',
    orangeHot: '#d84512',
    orangeDeep: '#a83008',
    purple: '#ea5a1c',   // light mode: no purple; use orange scale
    purpleDeep: '#a83008',
    pink: '#ea5a1c',
    green: '#15803d',
    red: '#c0362c',
    yellow: '#b8860b',
    blue: '#1e4e8c',
    chipBg: 'rgba(234,90,28,.06)',
    shadow: '0 8px 24px rgba(168,48,8,.08)',
  },
};

const G_ThemeCtx = React.createContext({ t: G_THEMES.dark, mode: 'dark', setMode: () => {} });
const useG = () => React.useContext(G_ThemeCtx);
const G_LayoutCtx = React.createContext({
  width: 1440,
  height: 900,
  isMobile: false,
  isTablet: false,
  isCompact: false,
  sidebarOverlay: false,
  detailOverlay: false,
  stackPanels: false,
  kbdLabel: 'Ctrl',
});
const useGLayout = () => React.useContext(G_LayoutCtx);

const G_ICONS = {
  home: "M2 7l6-5 6 5v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z",
  menu: "M2 4h12M2 8h12M2 12h12",
  kanban: "M3 3v10M8 3v7M13 3v10",
  chat: "M2 4h12v8H6l-4 3z",
  tools: "M4 2l3 3-5 5 3 3 5-5 3 3 2-2-9-9z",
  code: "M5 4L1 8l4 4M11 4l4 4-4 4M9 3l-2 10",
  bolt: "M9 1L3 9h4l-1 6 6-8H8z",
  gear: "M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3",
  plus: "M8 2v12M2 8h12",
  search: "M7 2a5 5 0 1 0 0 10A5 5 0 0 0 7 2zM11 11l3 3",
  send: "M2 8L14 2l-3 12-3-5z",
  play: "M4 2l10 6-10 6z",
  pause: "M5 3v10M11 3v10",
  check: "M3 8l3 3 7-7",
  clock: "M8 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12zM8 4v4l3 2",
  warn: "M8 1l7 14H1zM8 6v4M8 12v.5",
  chevR: "M6 3l5 5-5 5",
  chevD: "M3 6l5 5 5-5",
  chevL: "M10 3L5 8l5 5",
  x: "M3 3l10 10M13 3L3 13",
  mic: "M8 1a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0V3a2 2 0 0 0-2-2zM4 7a4 4 0 0 0 8 0M8 11v3",
  terminal: "M2 3h12v10H2zM4 6l2 2-2 2M8 10h4",
  refresh: "M14 8a6 6 0 1 1-2-4.5M13 1v3h-3",
  file: "M3 2h7l3 3v9H3z",
  folder: "M2 4h4l1 1h7v8H2z",
  bell: "M8 1a4 4 0 0 0-4 4v3l-2 2h12l-2-2V5a4 4 0 0 0-4-4zM6 13a2 2 0 0 0 4 0",
  attach: "M5 8l4-4a3 3 0 1 1 4 4l-6 6a2 2 0 1 1-3-3l5-5",
  spark: "M8 2v4M8 10v4M2 8h4M10 8h4M4 4l2.5 2.5M9.5 9.5L12 12M4 12l2.5-2.5M9.5 6.5L12 4",
  eye: "M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  zap: "M8 1L2 9h4v6l6-8H8z",
  sun: "M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1",
  moon: "M13 9a5 5 0 1 1-6-6 4 4 0 0 0 6 6z",
  trash: "M3 4h10M6 4V2h4v2M5 4l1 10h4l1-10",
  filter: "M2 3h12L10 9v5l-4-2V9z",
  check2: "M3 8l3 3 7-7",
};

function GIcon({ d, size = 14, stroke = 1.7 }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"><path d={d}/></svg>;
}

function GDot({ color, glow = true, size = 7, pulse = false }) {
  return <div className={pulse ? 'g-pulse' : ''} style={{ width: size, height: size, borderRadius: size, background: color, boxShadow: glow ? `0 0 ${size + 3}px ${color}` : 'none', flexShrink: 0 }} />;
}

function GTag({ children, color, solid = false }) {
  const { t } = useG();
  const c = color || t.orange;
  return (
    <span style={{
      fontSize: 9.5, padding: '2px 7px', borderRadius: 4,
      background: solid ? c : `${c}22`,
      color: solid ? (t === G_THEMES.light ? '#fff' : '#1a0f06') : c,
      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      fontWeight: solid ? 600 : 500,
      border: solid ? 'none' : `1px solid ${c}33`,
      whiteSpace: 'nowrap', letterSpacing: .2,
    }}>{children}</span>
  );
}

// Liquid background — canvas-based animated mesh that lives behind everything
function GLiquid() {
  const { mode } = useG();
  const ref = React.useRef(null);
  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let raf, t0 = performance.now();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const blobs = mode === 'dark' ? [
      { hue: 270, sat: 75, light: 55, alpha: .45, baseX: .15, baseY: .25, r: .55, speed: .00012, phase: 0 },
      { hue: 22, sat: 90, light: 60, alpha: .42, baseX: .85, baseY: .8, r: .6, speed: .00015, phase: 1.2 },
      { hue: 320, sat: 75, light: 60, alpha: .28, baseX: .55, baseY: .5, r: .4, speed: .0002, phase: 2.3 },
      { hue: 250, sat: 70, light: 50, alpha: .35, baseX: .4, baseY: .85, r: .45, speed: .00018, phase: 3.1 },
    ] : [
      { hue: 22, sat: 85, light: 65, alpha: .32, baseX: .15, baseY: .25, r: .55, speed: .00012, phase: 0 },
      { hue: 35, sat: 90, light: 70, alpha: .28, baseX: .85, baseY: .8, r: .6, speed: .00015, phase: 1.2 },
      { hue: 15, sat: 80, light: 68, alpha: .22, baseX: .55, baseY: .5, r: .4, speed: .0002, phase: 2.3 },
      { hue: 42, sat: 85, light: 75, alpha: .25, baseX: .4, baseY: .85, r: .45, speed: .00018, phase: 3.1 },
    ];

    const loop = (now) => {
      const { width: w, height: h } = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, w, h);
      const t = (now - t0);
      for (const b of blobs) {
        const ox = Math.sin(t * b.speed + b.phase) * 0.15;
        const oy = Math.cos(t * b.speed * 1.3 + b.phase * 0.7) * 0.15;
        const cx = (b.baseX + ox) * w;
        const cy = (b.baseY + oy) * h;
        const rad = b.r * Math.min(w, h);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
        g.addColorStop(0, `hsla(${b.hue},${b.sat}%,${b.light}%,${b.alpha})`);
        g.addColorStop(1, `hsla(${b.hue},${b.sat}%,${b.light}%,0)`);
        ctx.fillStyle = g;
        ctx.globalCompositeOperation = mode === 'dark' ? 'screen' : 'multiply';
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, [mode]);

  return (
    <canvas ref={ref} style={{
      position: 'absolute', inset: 0, width: '100%', height: '100%',
      pointerEvents: 'none', filter: 'blur(40px)', opacity: mode === 'dark' ? 1 : 0.9,
      transition: 'opacity .4s',
    }}/>
  );
}

// Animated number counter
function GCount({ to, duration = 1400, format = (n) => n, style }) {
  const [v, setV] = React.useState(0);
  const startRef = React.useRef(null);
  React.useEffect(() => {
    let raf;
    const step = (now) => {
      if (!startRef.current) startRef.current = now;
      const p = Math.min(1, (now - startRef.current) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setV(to * eased);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, duration]);
  return <span style={{ fontVariantNumeric: 'tabular-nums', ...style }}>{format(v)}</span>;
}

Object.assign(window, { G_THEMES, G_ThemeCtx, useG, G_LayoutCtx, useGLayout, G_ICONS, GIcon, GDot, GTag, GLiquid, GCount });
