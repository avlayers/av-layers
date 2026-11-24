import { Layer, project32, type LayerContext, type UpdateParameters } from '@deck.gl/core';
import type { Buffer, Texture } from '@luma.gl/core';
import { BufferTransform, Geometry, Model, type ModelProps } from '@luma.gl/engine';
import type { WindPreparedGrid } from '@av/client/wind';
import { WIND_TRAIL_WIDTH } from '../raster/raster-budget';

export interface WindParticleLayerProps {
  prepared: WindPreparedGrid | null;
  gridBounds: readonly [number, number, number, number];
  spawnBounds: readonly [number, number, number, number];
  numParticles: number;
  trailSteps?: number;
  paused: boolean;
  darkChrome?: boolean;
  centerLon: number;
  zoom: number;
  beforeId?: string;
}

interface UpdateUniforms {
  u_wind?: Texture;
  gridBounds: readonly [number, number, number, number];
  spawnBounds: readonly [number, number, number, number];
  gridSize: number;
  numParticles: number;
  zoom: number;
  dt: number;
  seed: number;
  pad0: number;
  pad1: number;
  pad2: number;
}

interface DrawUniforms {
  numParticles: number;
  trailSteps: number;
  lineWidth: number;
  opacity: number;
  centerLon: number;
  stepSec: number;
  pad0: number;
  pad1: number;
}

const DEFAULT_TRAIL_STEPS = 68;
const STEP_SEC = 0.035;
const PREWARM_STEPS = 54;
const RENDERED_LINE_WIDTH = WIND_TRAIL_WIDTH * 1.42;

function isSoftwareOrAutomatedRenderer(): boolean {
  if (typeof navigator !== 'undefined' && navigator.webdriver) return true;
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  return env?.VITE_OFFLINE_FIXTURE === 'true';
}

type LumaModule = NonNullable<ModelProps['modules']>[number];

const windUpdateModule: LumaModule = {
  name: 'windUpdate',
  vs: `\
uniform sampler2D u_wind;
layout(std140) uniform windUpdateUniforms {
  vec4 gridBounds;
  vec4 spawnBounds;
  float gridSize;
  float numParticles;
  float zoom;
  float dt;
  float seed;
  float pad0;
  float pad1;
  pad2_placeholder;
} windUpdate;
`.replace('pad2_placeholder;', 'float pad2;'),
  uniformTypes: {
    gridBounds: 'vec4<f32>',
    spawnBounds: 'vec4<f32>',
    gridSize: 'f32',
    numParticles: 'f32',
    zoom: 'f32',
    dt: 'f32',
    seed: 'f32',
    pad0: 'f32',
    pad1: 'f32',
    pad2: 'f32'
  },
  getUniforms: (props?: Partial<UpdateUniforms>) => props ?? {}
};

const windDrawModule: LumaModule = {
  name: 'windDraw',
  vs: `\
layout(std140) uniform windDrawUniforms {
  float numParticles;
  float trailSteps;
  float lineWidth;
  float opacity;
  float centerLon;
  float stepSec;
  float pad0;
  float pad1;
} windDraw;
`,
  fs: `\
layout(std140) uniform windDrawUniforms {
  float numParticles;
  float trailSteps;
  float lineWidth;
  float opacity;
  float centerLon;
  float stepSec;
  float pad0;
  float pad1;
} windDraw;
`,
  uniformTypes: {
    numParticles: 'f32',
    trailSteps: 'f32',
    lineWidth: 'f32',
    opacity: 'f32',
    centerLon: 'f32',
    stepSec: 'f32',
    pad0: 'f32',
    pad1: 'f32'
  },
  getUniforms: (props?: Partial<DrawUniforms>) => props ?? {}
};

const UPDATE_VS = `#version 300 es
#define SHADER_NAME wind-particle-update-vs
precision highp float;

in vec4 a_state;
out vec4 v_next;

const float DEG = 0.017453292519943295;
const float MAX_LAT = 85.05112878;

float hash1(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

float mercY(float lat) {
  return log(tan(0.7853981633974483 + 0.5 * clamp(lat, -MAX_LAT, MAX_LAT) * DEG));
}

float invMercY(float my) {
  return (2.0 * atan(exp(my)) - 1.5707963267948966) / DEG;
}

vec2 spawnLonLat(float idx, float s) {
  vec2 base = vec2(idx / max(1.0, windUpdate.numParticles), fract(s * 0.7123 + idx * 0.00173));
  float rx = hash1(base + vec2(s, 0.13));
  float ry = hash1(base.yx + vec2(0.71, s * 1.37));
  float lon = mix(windUpdate.spawnBounds.x, windUpdate.spawnBounds.z, rx);
  float lat = invMercY(mix(mercY(windUpdate.spawnBounds.y), mercY(windUpdate.spawnBounds.w), ry));
  return vec2(lon, lat);
}

vec3 samplePrepared(vec2 lonLat) {
  vec4 b = windUpdate.gridBounds;
  float spanLon = b.z - b.x;
  float spanLat = b.w - b.y;
  if (spanLon <= 0.0 || spanLat <= 0.0 || lonLat.y < b.y || lonLat.y > b.w) return vec3(0.0);
  float relLon = mod(lonLat.x - b.x, 360.0);
  if (relLon < 0.0) relLon += 360.0;
  bool globalLon = spanLon >= 359.0;
  if (relLon > spanLon) {
    if (globalLon) relLon = mod(relLon, spanLon);
    else return vec3(0.0);
  }
  float size = windUpdate.gridSize;
  int isize = max(1, int(size));
  int maxIdx = isize - 1;
  float gx = (relLon / spanLon) * size - 0.5;
  float gy = ((lonLat.y - b.y) / spanLat) * size - 0.5;
  int rx0 = int(floor(gx));
  int ry0 = int(floor(gy));
  int x0 = globalLon ? ((rx0 % isize) + isize) % isize : clamp(rx0, 0, maxIdx);
  int x1 = globalLon ? (x0 + 1) % isize : clamp(rx0 + 1, 0, maxIdx);
  int y0 = clamp(ry0, 0, maxIdx);
  int y1 = clamp(ry0 + 1, 0, maxIdx);
  float fx = clamp(gx - floor(gx), 0.0, 1.0);
  float fy = clamp(gy - floor(gy), 0.0, 1.0);
  float wx[2] = float[2](1.0 - fx, fx);
  float wy[2] = float[2](1.0 - fy, fy);
  int xs[2] = int[2](x0, x1);
  int ys[2] = int[2](y0, y1);
  vec2 acc = vec2(0.0);
  float wsum = 0.0;
  for (int iy = 0; iy < 2; iy++) {
    for (int ix = 0; ix < 2; ix++) {
      vec4 tap = texelFetch(u_wind, ivec2(xs[ix], ys[iy]), 0);
      float w = wx[ix] * wy[iy];
      if (tap.a > 0.5 && w > 0.0) {
        acc += (tap.rg * 200.0 - 100.0) * w;
        wsum += w;
      }
    }
  }
  return wsum > 0.0 ? vec3(acc / wsum, 1.0) : vec3(0.0);
}

void main() {
  float idx = float(gl_VertexID);
  vec4 s = a_state;
  float gen = s.w;
  bool outside = s.y < windUpdate.spawnBounds.y - 0.5 || s.y > windUpdate.spawnBounds.w + 0.5;
  if (!outside) {
    float spanSpawn = windUpdate.spawnBounds.z - windUpdate.spawnBounds.x;
    if (spanSpawn < 355.0) {
      float dLon = mod(s.x - windUpdate.spawnBounds.x, 360.0);
      if (dLon < 0.0) dLon += 360.0;
      if (dLon > spanSpawn + 1.0 && dLon < 359.0) outside = true;
    }
  }
  if (s.z <= 0.0 || outside) {
    vec2 pos = spawnLonLat(idx, windUpdate.seed + gen * 0.37);
    vec3 w0 = samplePrepared(pos);
    float speed0 = length(w0.xy);
    float life = gen == 0.0
      ? 0.15 + 3.85 * hash1(vec2(idx * 0.0293, 1.91))
      : 1.5 + 2.5 * hash1(vec2(idx * 0.0131, windUpdate.seed + 3.7));
    v_next = vec4(mod(pos.x + 540.0, 360.0) - 180.0, pos.y, w0.z > 0.5 && speed0 >= 0.2 ? life : 0.0, gen + 1.0);
    return;
  }
  vec3 w = samplePrepared(s.xy);
  float speed = length(w.xy);
  if (w.z < 0.5 || speed < 0.15) {
    v_next = vec4(s.xy, 0.0, gen + 1.0);
    return;
  }
  float boost = speed < 4.0 ? sqrt(4.0 / speed) : 1.0;
  float cosLat = max(0.05, cos(s.y * DEG));
  float sec = windUpdate.dt * 600.0 * exp2(9.0 - windUpdate.zoom) * cosLat * boost;
  float nextLat = clamp(s.y + w.y * sec / 6371000.0 / DEG, -MAX_LAT, MAX_LAT);
  float nextLon = mod(s.x + w.x * sec / (6371000.0 * cosLat) / DEG + 540.0, 360.0) - 180.0;
  v_next = vec4(nextLon, nextLat, max(0.0, s.z - windUpdate.dt), gen);
}
`;

const DRAW_VS = `#version 300 es
#define SHADER_NAME wind-particle-draw-vs
precision highp float;

in vec3 positions;
in vec4 instanceCurr;
in vec4 instancePrev;
out float vAlpha;
out vec2 vCap;
out float vHalfWidth;
out float vCasing;
out float vFeather;

void main(void) {
  int nParticles = max(1, int(windDraw.numParticles));
  int slice = gl_InstanceID / nParticles;
  if (instanceCurr.z <= 0.0 || instancePrev.z <= 0.0 || abs(instanceCurr.w - instancePrev.w) > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0; vCap = vec2(0.0); vHalfWidth = 0.0; vCasing = 0.0; vFeather = 1.0;
    return;
  }
  float currLon = instanceCurr.x + 360.0 * floor((windDraw.centerLon - instanceCurr.x) / 360.0 + 0.5);
  float prevLon = instancePrev.x + 360.0 * floor((currLon - instancePrev.x) / 360.0 + 0.5);
  vec4 commonPrev;
  vec4 commonCurr;
  vec4 prevClip = project_position_to_clipspace(vec3(prevLon, instancePrev.y, 0.0), vec3(0.0), vec3(0.0), commonPrev);
  vec4 currClip = project_position_to_clipspace(vec3(currLon, instanceCurr.y, 0.0), vec3(0.0), vec3(0.0), commonCurr);
  if (prevClip.w <= 0.0 || currClip.w <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0; vCap = vec2(0.0); vHalfWidth = 0.0; vCasing = 0.0; vFeather = 1.0;
    return;
  }
  float dpr = max(project.devicePixelRatio, 1.0);
  vec2 cssViewport = max(project.viewportSize / dpr, vec2(1.0));
  vec2 prevPx = (prevClip.xy / prevClip.w) * 0.5 * cssViewport;
  vec2 currPx = (currClip.xy / currClip.w) * 0.5 * cssViewport;
  vec2 delta = currPx - prevPx;
  float segLen = length(delta);
  if (segLen <= 0.06 || segLen > 36.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0; vCap = vec2(0.0); vHalfWidth = 0.0; vCasing = 0.0; vFeather = 1.0;
    return;
  }
  vec2 dir = delta / segLen;
  vec2 normal = vec2(-dir.y, dir.x);
  float halfWidth = windDraw.lineWidth * 0.5;
  float casing = max(0.75, windDraw.pad0) / dpr;
  float feather = 0.85 / dpr;
  float ext = halfWidth + casing + feather;
  bool headSlice = slice == 0;
  vec4 baseClip = mix(prevClip, currClip, positions.x);
  vec2 offsetCss = normal * (positions.y * ext) + (headSlice && positions.x > 0.5 ? dir * ext : vec2(0.0));
  gl_Position = vec4(baseClip.xy + (offsetCss / (cssViewport * 0.5)) * baseClip.w, baseClip.z, baseClip.w);
  float maxDuration = max(windDraw.trailSteps - 1.0, 1.0) * windDraw.stepSec;
  float ageSec = mix(float(slice + 1), float(slice), positions.x) * windDraw.stepSec;
  float fade = exp(-ageSec * 0.9) * smoothstep(maxDuration, maxDuration * 0.72, ageSec) * smoothstep(0.08, 0.26, segLen);
  vAlpha = windDraw.opacity * fade;
  vCap = vec2(headSlice ? mix(-segLen, ext, positions.x) : -1.0, positions.y * ext);
  vHalfWidth = halfWidth;
  vCasing = casing;
  vFeather = feather;
}
`;

const DRAW_FS = `#version 300 es
#define SHADER_NAME wind-particle-draw-fs
precision highp float;

in float vAlpha;
in vec2 vCap;
in float vHalfWidth;
in float vCasing;
in float vFeather;
out vec4 fragColor;

void main() {
  if (vAlpha <= 0.002) discard;
  float d = length(vec2(max(vCap.x, 0.0), vCap.y));
  float outerLimit = vHalfWidth + vCasing;
  float outerMask = 1.0 - smoothstep(outerLimit - vFeather * 0.5, outerLimit + vFeather * 0.5, d);
  if (outerMask <= 0.002) discard;
  float coreMask = 1.0 - smoothstep(max(0.0, vHalfWidth - vFeather * 0.45), vHalfWidth + vFeather * 0.45, d);
  float coreAlpha = vAlpha * coreMask;
  float caseStrength = windDraw.pad1 > 0.0 ? windDraw.pad1 : 0.68;
  float caseAlpha = vAlpha * caseStrength * max(0.0, outerMask - coreMask * 0.62);
  float outAlpha = coreAlpha + caseAlpha * (1.0 - coreAlpha);
  if (outAlpha <= 0.002) discard;
  vec3 outRgb = (vec3(1.0) * coreAlpha + vec3(0.05, 0.09, 0.16) * caseAlpha * (1.0 - coreAlpha)) / outAlpha;
  fragColor = vec4(outRgb, outAlpha);
}
`;

interface ParticleState {
  model?: Model;
  transform?: BufferTransform;
  currBuffer?: Buffer;
  prevBuffer?: Buffer;
  windTexture?: Texture;
  uploadedKey?: string;
  numParticles?: number;
  trailSteps?: number;
  lastStepMs?: number;
  prewarmed?: boolean;
}

/** GPU Transform-Feedback streamline layer matching prod advection and valid-donor sampling. */
export class WindParticleLayer extends Layer<WindParticleLayerProps> {
  static override layerName = 'WindParticleLayer';
  static override defaultProps = {
    prepared: { type: 'object', value: null, compare: false },
    gridBounds: { type: 'array', value: [-180, -85, 180, 85], compare: true },
    spawnBounds: { type: 'array', value: [-180, -85, 180, 85], compare: true },
    numParticles: { type: 'number', value: 1408 },
    trailSteps: { type: 'number', value: DEFAULT_TRAIL_STEPS },
    paused: { type: 'boolean', value: false },
    darkChrome: { type: 'boolean', value: false },
    centerLon: { type: 'number', value: 0 },
    zoom: { type: 'number', value: 5 }
  };

  declare state: Layer['state'] & ParticleState;

  override getShaders() {
    return super.getShaders({
      vs: DRAW_VS,
      fs: DRAW_FS,
      modules: [project32, windDrawModule]
    });
  }

  override initializeState(): void {
    this.state = {};
  }

  override updateState(params: UpdateParameters<Layer<WindParticleLayerProps>>): void {
    super.updateState(params);
    const { props } = params;
    const throttled = isSoftwareOrAutomatedRenderer();
    const numParticles = throttled ? Math.min(props.numParticles, 64) : props.numParticles;
    const steps = throttled ? Math.min(props.trailSteps ?? DEFAULT_TRAIL_STEPS, 8) : (props.trailSteps ?? DEFAULT_TRAIL_STEPS);
    const prewarmSteps = throttled ? 2 : PREWARM_STEPS;
    if (!props.prepared || !props.visible || numParticles <= 0) {
      this.destroyResources();
      return;
    }
    if (this.state.numParticles !== numParticles || this.state.trailSteps !== steps || !this.state.model) {
      this.setupResources(numParticles, steps);
    }
    if (this.state.uploadedKey !== props.prepared.key || !this.state.windTexture) {
      this.uploadWind(props.prepared);
    }
    if (!props.paused && !this.state.prewarmed) {
      this.state.prewarmed = true;
      for (let i = 0; i < prewarmSteps; i++) this.stepSimulation(STEP_SEC, i * 0.173 + 0.11);
      this.state.lastStepMs = performance.now();
    }
  }

  override finalizeState(context: LayerContext): void {
    this.destroyResources();
    super.finalizeState(context);
  }

  override draw(): void {
    const { model, transform, currBuffer, prevBuffer, windTexture, numParticles } = this.state;
    const { prepared, paused, visible } = this.props;
    if (!model || !transform || !currBuffer || !prevBuffer || !windTexture || !prepared || !visible || !numParticles) return;

    const throttled = isSoftwareOrAutomatedRenderer();
    const steps = this.state.trailSteps ?? DEFAULT_TRAIL_STEPS;
    const dark = Boolean(this.props.darkChrome);
    model.setAttributes({ instanceCurr: currBuffer, instancePrev: prevBuffer });
    model.setInstanceCount(numParticles * (steps - 1));
    model.shaderInputs.setProps({
      windDraw: {
        numParticles,
        trailSteps: steps,
        lineWidth: RENDERED_LINE_WIDTH,
        opacity: 0.96,
        centerLon: this.props.centerLon,
        stepSec: STEP_SEC,
        pad0: dark ? 0.90 : 1.18,
        pad1: dark ? 0.46 : 0.76
      }
    });
    model.draw(this.context.renderPass);

    if (!paused && !throttled && (typeof document === 'undefined' || !document.hidden)) {
      const now = performance.now();
      if (!this.state.prewarmed) {
        this.state.prewarmed = true;
        for (let i = 0; i < PREWARM_STEPS; i++) this.stepSimulation(STEP_SEC, i * 0.173 + 0.11);
        this.state.lastStepMs = now;
      } else if (this.state.lastStepMs === undefined) {
        this.stepSimulation(STEP_SEC, (now % 10000) * 0.001);
        this.state.lastStepMs = now;
      } else {
        const elapsed = (now - this.state.lastStepMs) / 1000;
        if (elapsed >= STEP_SEC) {
          const catchUp = Math.min(3, Math.floor(elapsed / STEP_SEC));
          for (let i = 0; i < catchUp; i++) {
            this.stepSimulation(STEP_SEC, ((now + i * 35) % 10000) * 0.001);
          }
          this.state.lastStepMs += catchUp * STEP_SEC * 1000;
          if (now - this.state.lastStepMs > 120) this.state.lastStepMs = now;
        }
      }
      this.setNeedsRedraw();
    } else {
      this.state.lastStepMs = undefined;
    }
  }

  private stepSimulation(dt: number, seed: number): void {
    const { transform, currBuffer, prevBuffer, windTexture, numParticles, trailSteps } = this.state;
    const { prepared } = this.props;
    if (!transform || !currBuffer || !prevBuffer || !windTexture || !prepared || !numParticles || !trailSteps) return;

    const device = this.context.device;
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer({
      sourceBuffer: currBuffer,
      sourceOffset: 0,
      destinationBuffer: prevBuffer,
      destinationOffset: numParticles * 16,
      size: numParticles * (trailSteps - 1) * 16
    });
    const commandBuffer = encoder.finish();
    device.submit(commandBuffer);
    encoder.destroy();

    transform.model.setAttributes({ a_state: currBuffer });
    transform.transformFeedback.setBuffers({ v_next: { buffer: prevBuffer, byteOffset: 0, byteLength: numParticles * 16 } });
    transform.model.setBindings({ u_wind: windTexture });
    transform.model.shaderInputs.setProps({
      windUpdate: {
        gridBounds: this.props.gridBounds,
        spawnBounds: this.props.spawnBounds,
        gridSize: prepared.size,
        numParticles,
        zoom: this.props.zoom,
        dt,
        seed,
        pad0: 0,
        pad1: 0,
        pad2: 0
      }
    });
    transform.run({
      clearColor: false,
      clearDepth: false,
      clearStencil: false,
      depthReadOnly: true,
      stencilReadOnly: true
    });

    this.state.currBuffer = prevBuffer;
    this.state.prevBuffer = currBuffer;
  }

  private setupResources(numParticles: number, trailSteps: number): void {
    this.destroyResources();
    const device = this.context.device;
    const floats = numParticles * trailSteps * 4;
    const currBuffer = device.createBuffer(new Float32Array(floats));
    const prevBuffer = device.createBuffer(new Float32Array(floats));

    const transform = new BufferTransform(device, {
      id: `${this.props.id}-tf`,
      vs: UPDATE_VS,
      modules: [windUpdateModule],
      vertexCount: numParticles,
      bufferLayout: [{ name: 'a_state', format: 'float32x4' }],
      attributes: { a_state: currBuffer },
      feedbackBuffers: { v_next: { buffer: prevBuffer, byteOffset: 0, byteLength: numParticles * 16 } },
      varyings: ['v_next']
    });

    const positions = new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]);
    const model = new Model(device, {
      ...this.getShaders(),
      id: `${this.props.id}-draw`,
      bufferLayout: [
        { name: 'instanceCurr', format: 'float32x4', stepMode: 'instance' },
        { name: 'instancePrev', format: 'float32x4', stepMode: 'instance' }
      ],
      geometry: new Geometry({
        topology: 'triangle-strip',
        attributes: {
          positions: { size: 3, value: positions }
        }
      }),
      parameters: {
        depthWriteEnabled: false,
        depthCompare: 'always',
        cullMode: 'none',
        blend: true,
        blendColorSrcFactor: 'src-alpha',
        blendColorDstFactor: 'one-minus-src-alpha',
        blendAlphaSrcFactor: 'one',
        blendAlphaDstFactor: 'one-minus-src-alpha',
        blendColorOperation: 'add',
        blendAlphaOperation: 'add'
      },
      instanceCount: numParticles * (trailSteps - 1),
      disableWarnings: true
    });

    this.state.currBuffer = currBuffer;
    this.state.prevBuffer = prevBuffer;
    this.state.transform = transform;
    this.state.model = model;
    this.state.numParticles = numParticles;
    this.state.trailSteps = trailSteps;
    this.state.lastStepMs = undefined;
    this.state.prewarmed = false;
  }

  private uploadWind(prepared: WindPreparedGrid): void {
    this.state.windTexture?.destroy();
    const tex = this.context.device.createTexture({
      format: 'rgba8unorm',
      width: prepared.size,
      height: prepared.size,
      mipLevels: 1,
      sampler: {
        magFilter: 'nearest',
        minFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge'
      }
    });
    tex.copyImageData({ data: prepared.data, width: prepared.size, height: prepared.size });
    this.state.windTexture = tex;
    this.state.uploadedKey = prepared.key;
  }

  private destroyResources(): void {
    this.state.model?.destroy();
    this.state.transform?.transformFeedback?.destroy();
    this.state.transform?.destroy();
    this.state.currBuffer?.destroy();
    this.state.prevBuffer?.destroy();
    this.state.windTexture?.destroy();
    this.state.model = undefined;
    this.state.transform = undefined;
    this.state.currBuffer = undefined;
    this.state.prevBuffer = undefined;
    this.state.windTexture = undefined;
    this.state.uploadedKey = undefined;
    this.state.numParticles = undefined;
    this.state.trailSteps = undefined;
    this.state.lastStepMs = undefined;
    this.state.prewarmed = undefined;
  }
}
