// @ts-check
/**
 * The Scanner: an animated scan field behind the Landing's Observatory.
 *
 * Adapted, in plain WebGL, from the React Bits "Scanner" background's
 * parameters - no framework, no dependency. One full-screen triangle and one
 * fragment shader: horizontal scan bands (bandDensity, lineSharpness,
 * softness), warped by a slow ripple (frequency, ripple, scale), crossed by a
 * vertical sweep (sweepSpeed, sweepWidth, sweepFalloff) that lights them in a
 * violet-to-green field (color1, color2, colorSpread) with a white core
 * (color3, glow), then graded (brightness, contrast), vignetted and grained.
 *
 * It is decoration, and behaves like it:
 * - it never takes input (pointer-events: none, aria-hidden) and never
 *   changes layout;
 * - it draws only while on screen and while the tab is visible, at most 30
 *   frames a second, at a bounded resolution - so the Observatory's own
 *   animation keeps the frame budget;
 * - with reduced motion it draws one still frame and stops;
 * - without WebGL it does nothing, and the page's CSS atmosphere remains.
 *
 * Colour is written premultiplied with alpha equal to its brightness, so dark
 * parts of the field are transparent and the page shows through.
 */

/** The reference configuration. */
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
  scanDirection: /** @type {'vertical' | 'horizontal'} */ ('vertical'),
  colorSpread: 0.7,
  brightness: 1.0,
  contrast: 1.15,
  softness: 1.4,
  vignette: 0.45,
  grainIntensity: 0.05,
};

const MAX_DPR = 1.25;
/** Internal resolution relative to CSS pixels: the field is soft, so fewer pixels cost nothing visible. */
const RENDER_SCALE = 0.6;
const FRAME_MS = 1000 / 30;

const VERTEX = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAGMENT = `
precision mediump float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform float uSpeed, uSweepSpeed, uSweepWidth, uSweepFalloff, uScale, uFreq, uRipple;
uniform float uBands, uSharp, uGlow, uSpread, uBright, uContrast, uSoft, uVignette, uGrain;
uniform float uVertical;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float unit = min(uRes.x, uRes.y);
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / unit * uScale;
  // The scan runs along one axis; the field is written as if vertical.
  if (uVertical < 0.5) p = p.yx;
  float t = uTime * uSpeed;

  // A slow ripple bends the bands.
  vec2 q = p;
  q.y += uRipple * 0.5 * sin(p.x * uFreq * 1.7 + t * 1.3) * cos(p.y * uFreq * 0.9 - t * 0.7);
  q.x += uRipple * 0.3 * sin(p.y * uFreq * 1.3 + t);

  // Bands: thin lines whose sharpness softness relaxes.
  float wave = 0.5 + 0.5 * cos(q.y * uBands * 3.14159 + t * 0.6);
  float lines = pow(wave, uSharp / max(uSoft, 0.01));

  // The sweep travels top to bottom and wraps, eased at both ends.
  float extent = 0.5 * (uVertical > 0.5 ? uRes.y : uRes.x) / unit * uScale;
  float phase = fract(uTime * uSweepSpeed * 0.5);
  float sy = mix(extent * 1.25, -extent * 1.25, phase);
  float d = (q.y - sy) / (0.12 * uSweepWidth);
  float sweep = exp(-uSweepFalloff * 0.25 * d * d);
  float trail = exp(-max(q.y - sy, 0.0) * 1.6 / uSweepWidth) * step(sy, q.y) * 0.35;

  // Violet to green across the field, drifting; white at the sweep's core.
  float mixer = clamp(0.5 + 0.5 * sin(q.x * uSpread * 1.6 + q.y * 0.35 + t * 0.4), 0.0, 1.0);
  vec3 base = mix(uC1, uC2, mixer);
  float energy = lines * (0.34 + sweep * 1.1 + trail) + sweep * uGlow;
  vec3 col = base * energy + uC3 * pow(sweep, 3.0) * lines * uGlow * 1.6;

  // Grade.
  col = pow(max(col, 0.0), vec3(uContrast)) * uBright;

  // Vignette and grain.
  float r = length((uv - 0.5) * vec2(uRes.x / unit, uRes.y / unit));
  col *= 1.0 - uVignette * smoothstep(0.25, 1.05, r);
  col += (hash(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5) * uGrain * (0.25 + energy);
  col = clamp(col, 0.0, 1.0);

  float alpha = max(col.r, max(col.g, col.b));
  gl_FragColor = vec4(col, alpha);
}
`;

/** @param {string} hex @returns {[number, number, number]} */
function rgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** @param {WebGLRenderingContext} gl @param {number} type @param {string} source */
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
 * Mounts the Scanner as the first child of `host`. Returns a handle whose
 * `dispose` stops it and releases the GPU context.
 * @param {HTMLElement} host
 * @param {Partial<typeof SCANNER_CONFIG>} [overrides]
 * @returns {{ dispose: () => void, readonly running: boolean, readonly supported: boolean }}
 */
export function mountScanner(host, overrides = {}) {
  const config = { ...SCANNER_CONFIG, ...overrides };
  const canvas = document.createElement('canvas');
  canvas.className = 'landing__scanner';
  canvas.setAttribute('aria-hidden', 'true');
  host.prepend(canvas);

  const gl = /** @type {WebGLRenderingContext | null} */ (
    canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' })
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
    // No WebGL: the CSS atmosphere is the background, as before.
    canvas.remove();
    return { dispose() {}, get running() { return false; }, get supported() { return false; } };
  }

  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  // One triangle covering the viewport.
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  /** @param {string} name */
  const u = (name) => gl.getUniformLocation(program, name);
  const uRes = u('uRes');
  const uTime = u('uTime');
  gl.uniform3fv(u('uC1'), rgb(config.color1));
  gl.uniform3fv(u('uC2'), rgb(config.color2));
  gl.uniform3fv(u('uC3'), rgb(config.color3));
  gl.uniform1f(u('uSpeed'), config.speed);
  gl.uniform1f(u('uSweepSpeed'), config.sweepSpeed);
  gl.uniform1f(u('uSweepWidth'), config.sweepWidth);
  gl.uniform1f(u('uSweepFalloff'), config.sweepFalloff);
  gl.uniform1f(u('uScale'), config.scale);
  gl.uniform1f(u('uFreq'), config.frequency);
  gl.uniform1f(u('uRipple'), config.ripple);
  gl.uniform1f(u('uBands'), config.bandDensity);
  gl.uniform1f(u('uSharp'), config.lineSharpness);
  gl.uniform1f(u('uGlow'), config.glow);
  gl.uniform1f(u('uSpread'), config.colorSpread);
  gl.uniform1f(u('uBright'), config.brightness);
  gl.uniform1f(u('uContrast'), config.contrast);
  gl.uniform1f(u('uSoft'), config.softness);
  gl.uniform1f(u('uVignette'), config.vignette);
  gl.uniform1f(u('uGrain'), config.grainIntensity);
  gl.uniform1f(u('uVertical'), config.scanDirection === 'vertical' ? 1 : 0);

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let raf = 0;
  let last = 0;
  let onScreen = true;
  let disposed = false;
  const start = performance.now();
  /** The still frame shown with reduced motion: a sweep partway down. */
  const STILL_AT = 7.3;

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR) * RENDER_SCALE;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    gl.uniform2f(uRes, w, h);
  };

  /** @param {number} seconds */
  const draw = (seconds) => {
    gl.uniform1f(uTime, seconds);
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
    // A resize clears the buffer; a still frame must be drawn again.
    if (reduced.matches || !raf) draw(reduced.matches ? STILL_AT : (performance.now() - start) / 1000);
  });
  sizeObserver.observe(canvas);
  const viewObserver = new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting);
    sync();
  });
  viewObserver.observe(canvas);
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);

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
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
    },
  };
}
