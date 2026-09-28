// @ts-check
/**
 * The Scanner: the Landing's atmospheric background, behind the Observatory.
 *
 * A faithful port of React Bits' "Scanner" background - the same fragment
 * shader, uniforms and maths (signal field, sweep, anti-aliased scan bands,
 * chromatic split, palette, scanlines, grain, vignette) - driven by plain
 * WebGL2 instead of React and OGL. No framework, no dependency. Mouse
 * interaction is off: this layer never takes input.
 *
 * Integration, which is the only part that differs from the original:
 *
 * - The canvas is fixed to the viewport and sits behind the page (see
 *   `.landing__scanner`), so it has no box of its own to show: its bounds
 *   are the screen's. The Landing's content column is capped in width; a
 *   canvas inside it showed left and right edges on wider screens.
 * - The Observatory paints above it. So that the sphere stays dominant, the
 *   field is dimmed locally around the sphere's real on-screen position
 *   (`focus`), rather than globally.
 *
 * Behaviour: one animation loop, at most 30 frames a second, a bounded pixel
 * ratio; it stops off-screen and in a hidden tab, draws one still frame under
 * reduced motion, and does nothing without WebGL2 - the page's CSS
 * atmosphere remains.
 */

/** Token Finder's configuration of the Scanner. */
export const SCANNER_CONFIG = {
  color1: '#9945FF',
  color2: '#14F195',
  color3: '#FFFFFF',
  speed: 0.5,
  sweepSpeed: 0.25,
  sweepWidth: 1.6,
  sweepFalloff: 6,
  scale: 1.5,
  frequency: 2,
  ripple: 0.22,
  bandDensity: 11,
  lineSharpness: 5.5,
  glow: 0.22,
  scanDirection: /** @type {'vertical' | 'horizontal' | 'diagonal'} */ ('vertical'),
  colorSpread: 0.7,
  brightness: 1.0,
  contrast: 1.15,
  softness: 1.4,
  vignette: 0.45,
  scanline: true,
  grain: true,
  grainIntensity: 0.05,
  opacity: 1.0,
  /** How much the field fades around the sphere, 0-1. Token Finder's addition. */
  focusDim: 0.72,
};

const MAX_DPR = 1.25;
/** Internal resolution relative to CSS pixels. */
const RENDER_SCALE = 0.75;
const FRAME_MS = 1000 / 30;

const VERTEX = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

// The React Bits fragment shader, unchanged but for the focus dim at the end.
const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform float uSpeed;
uniform float uSweepSpeed;
uniform float uSweepWidth;
uniform float uSweepFalloff;
uniform float uScale;
uniform float uFrequency;
uniform float uRipple;
uniform float uBandDensity;
uniform float uLineSharpness;
uniform float uGlow;
uniform float uColorSpread;
uniform float uBrightness;
uniform float uContrast;
uniform float uSoftness;
uniform float uVignette;
uniform float uOpacity;
uniform float uScanline;
uniform float uGrain;
uniform float uGrainIntensity;
uniform float uDirection;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
uniform vec3 uFocus;
uniform float uFocusDim;
out vec4 fragColor;

const float TAU = 6.2831853;

float signalField(vec2 p, float t) {
  float w = sin(p.x * 1.3 + t * 0.7);
  w += sin(p.y * 1.7 - t * 0.52) * 0.8;
  w += sin((p.x + p.y) * 0.9 + t * 0.91) * 0.6;
  w += sin((p.x - p.y) * 1.53 - t * 0.63) * 0.42;
  return w * 0.35;
}

vec3 palette(float f) {
  f = clamp(f, 0.0, 1.0);
  f = pow(f, uContrast);
  vec3 c = mix(uColor1, uColor2, smoothstep(0.08, 0.6, f));
  return mix(c, uColor3, smoothstep(0.68, 1.0, f));
}

float scanBand(float x, float aa, float sharp) {
  float v = mix(0.5, 0.5 + 0.5 * cos(x * TAU), aa);
  return pow(v, sharp);
}

void main() {
  vec2 uv0 = (gl_FragCoord.xy * 2.0 - iResolution.xy) / iResolution.y;
  vec2 p = uv0 / max(uScale, 0.001);

  float t = iTime * uSpeed;

  float axis;
  if (uDirection < 0.5) axis = p.y;
  else if (uDirection < 1.5) axis = p.x;
  else axis = (p.x + p.y) * 0.70710678;

  float sig = signalField(p * uFrequency, t);
  float coord = axis + sig * uRipple;

  float phase = coord / max(uSweepWidth, 0.05) - t * uSweepSpeed;
  float sweep = pow(0.5 + 0.5 * cos(phase * TAU), max(uSweepFalloff, 0.1));

  float lc = coord * uBandDensity;
  float aa = 1.0 / (1.0 + uSoftness * fwidth(lc) * 3.0);
  aa = clamp(aa, 0.0, 1.0);

  float bodyBase = clamp(0.5 + 0.5 * sig, 0.0, 1.0);
  float body = bodyBase * bodyBase * uGlow * sweep;

  float sharp = max(uLineSharpness, 0.1);
  float split = uColorSpread * 0.16;
  float fr = clamp(scanBand(lc + split, aa, sharp) * sweep + body, 0.0, 1.0);
  float fg = clamp(scanBand(lc, aa, sharp) * sweep + body, 0.0, 1.0);
  float fb = clamp(scanBand(lc - split, aa, sharp) * sweep + body, 0.0, 1.0);

  vec3 col = vec3(palette(fr).r, palette(fg).g, palette(fb).b);

  float inten = (fr + fg + fb) * 0.3333333 * uBrightness;

  if (uScanline > 0.5) {
    inten *= 1.0 - 0.18 * (0.5 + 0.5 * cos(gl_FragCoord.y * 1.7));
  }

  if (uGrain > 0.5) {
    float g = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + iTime) * 43758.5453);
    inten += (g - 0.5) * uGrainIntensity;
  }

  inten *= clamp(1.0 - uVignette * smoothstep(0.55, 1.65, length(uv0)), 0.0, 1.0);

  // Token Finder: the sphere stays in front. uFocus is its centre and radius
  // in drawing-buffer pixels (y up); the field eases away inside it.
  if (uFocus.z > 0.0) {
    float d = distance(gl_FragCoord.xy, uFocus.xy);
    inten *= 1.0 - uFocusDim * (1.0 - smoothstep(uFocus.z * 0.35, uFocus.z * 1.1, d));
  }

  inten = clamp(inten, 0.0, 1.0);

  float a = clamp(inten * uOpacity, 0.0, 1.0);
  fragColor = vec4(clamp(col, 0.0, 1.0) * a, a);
}
`;

/** @param {string} hex @returns {[number, number, number]} */
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return [1, 1, 1];
  return [parseInt(m[1] ?? 'ff', 16) / 255, parseInt(m[2] ?? 'ff', 16) / 255, parseInt(m[3] ?? 'ff', 16) / 255];
}

/** @param {string} dir */
const directionToFloat = (dir) => (dir === 'horizontal' ? 1.0 : dir === 'diagonal' ? 2.0 : 0.0);

/** @param {WebGL2RenderingContext} gl @param {number} type @param {string} source */
function compile(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * Mounts the Scanner as the first child of `host`.
 * @param {HTMLElement} host
 * @param {{ focus?: () => { x: number, y: number, r: number } | null } & Partial<typeof SCANNER_CONFIG>} [options]
 *   `focus` returns the sphere's centre and radius in viewport CSS pixels.
 * @returns {{ dispose: () => void, readonly running: boolean, readonly supported: boolean }}
 */
export function mountScanner(host, options = {}) {
  const { focus, ...overrides } = options;
  const config = { ...SCANNER_CONFIG, ...overrides };
  const canvas = document.createElement('canvas');
  canvas.className = 'landing__scanner';
  canvas.setAttribute('aria-hidden', 'true');
  host.prepend(canvas);

  const gl = /** @type {WebGL2RenderingContext | null} */ (
    canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' })
  );
  const vs = gl && compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = gl && compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl && vs && fs ? gl.createProgram() : null;
  if (gl && program && vs && fs) {
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
  }
  if (!gl || !program || !gl.getProgramParameter(program, gl.LINK_STATUS)) {
    canvas.remove();
    return { dispose() {}, get running() { return false; }, get supported() { return false; } };
  }

  gl.useProgram(program);
  gl.clearColor(0, 0, 0, 0);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  // One triangle covering the viewport, as OGL's Triangle does.
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  /** @param {string} name */
  const u = (name) => gl.getUniformLocation(program, name);
  const uRes = u('iResolution');
  const uTime = u('iTime');
  const uFocus = u('uFocus');
  gl.uniform1f(u('uSpeed'), config.speed);
  gl.uniform1f(u('uSweepSpeed'), config.sweepSpeed);
  gl.uniform1f(u('uSweepWidth'), config.sweepWidth);
  gl.uniform1f(u('uSweepFalloff'), config.sweepFalloff);
  gl.uniform1f(u('uScale'), config.scale);
  gl.uniform1f(u('uFrequency'), config.frequency);
  gl.uniform1f(u('uRipple'), config.ripple);
  gl.uniform1f(u('uBandDensity'), config.bandDensity);
  gl.uniform1f(u('uLineSharpness'), config.lineSharpness);
  gl.uniform1f(u('uGlow'), config.glow);
  gl.uniform1f(u('uColorSpread'), config.colorSpread);
  gl.uniform1f(u('uBrightness'), config.brightness);
  gl.uniform1f(u('uContrast'), config.contrast);
  gl.uniform1f(u('uSoftness'), config.softness);
  gl.uniform1f(u('uVignette'), config.vignette);
  gl.uniform1f(u('uOpacity'), config.opacity);
  gl.uniform1f(u('uScanline'), config.scanline ? 1 : 0);
  gl.uniform1f(u('uGrain'), config.grain ? 1 : 0);
  gl.uniform1f(u('uGrainIntensity'), config.grainIntensity);
  gl.uniform1f(u('uDirection'), directionToFloat(config.scanDirection));
  gl.uniform3fv(u('uColor1'), hexToRgb(config.color1));
  gl.uniform3fv(u('uColor2'), hexToRgb(config.color2));
  gl.uniform3fv(u('uColor3'), hexToRgb(config.color3));
  gl.uniform1f(u('uFocusDim'), config.focusDim);
  gl.uniform3f(uFocus, 0, 0, 0);

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let raf = 0;
  let last = 0;
  let onScreen = true;
  let disposed = false;
  let scaleX = 1;
  let scaleY = 1;
  const start = performance.now();
  /** The still frame shown with reduced motion. */
  const STILL_AT = 6.5;

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR) * RENDER_SCALE;
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform2f(uRes, gl.drawingBufferWidth, gl.drawingBufferHeight);
    scaleX = gl.drawingBufferWidth / Math.max(1, rect.width);
    scaleY = gl.drawingBufferHeight / Math.max(1, rect.height);
  };

  /** The sphere's centre and radius, in drawing-buffer pixels with y up. */
  const updateFocus = () => {
    const f = focus?.();
    if (!f || !(f.r > 0)) {
      gl.uniform3f(uFocus, 0, 0, 0);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    gl.uniform3f(uFocus, (f.x - rect.left) * scaleX, gl.drawingBufferHeight - (f.y - rect.top) * scaleY, f.r * scaleX);
  };

  /** @param {number} seconds */
  const draw = (seconds) => {
    updateFocus();
    gl.uniform1f(uTime, seconds);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const shouldRun = () => !disposed && onScreen && !document.hidden && !reduced.matches;

  /** @param {number} now */
  const frame = (now) => {
    raf = 0;
    if (!shouldRun()) return;
    if (now - last >= FRAME_MS) {
      last = now;
      draw((now - start) / 1000);
    }
    raf = requestAnimationFrame(frame);
  };

  /** The one place the loop starts or stops: never two loops. */
  const sync = () => {
    if (disposed) return;
    if (reduced.matches) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      draw(STILL_AT);
      return;
    }
    if (shouldRun() && !raf) raf = requestAnimationFrame(frame);
    else if (!shouldRun() && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  const sizeObserver = new ResizeObserver(() => {
    resize();
    if (!raf) draw(reduced.matches ? STILL_AT : (performance.now() - start) / 1000);
  });
  sizeObserver.observe(canvas);
  const viewObserver = new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting);
    sync();
  });
  viewObserver.observe(canvas);
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);
  // With reduced motion the still frame follows the sphere as the page scrolls.
  const onScroll = () => {
    if (reduced.matches && !disposed) draw(STILL_AT);
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  resize();
  sync();

  return {
    get running() {
      return raf !== 0;
    },
    get supported() {
      return true;
    },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      sizeObserver.disconnect();
      viewObserver.disconnect();
      document.removeEventListener('visibilitychange', sync);
      reduced.removeEventListener('change', sync);
      window.removeEventListener('scroll', onScroll);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
    },
  };
}
