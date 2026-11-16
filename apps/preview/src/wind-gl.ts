import { STATUS_MASK, STATUS_VALID } from '@av/contracts/layers';
import type { CustomLayerInterface, Map } from 'maplibre-gl';
import { WIND_TRAIL_BIAS, WIND_TRAIL_FADE, WIND_TRAIL_GAIN, windParticleCount, windTrailWidth } from './raster-budget';
import { PLAYBACK_STEP_MS } from './timeline';

export interface WindSampleField { sample(lat: number, lon: number): { u: number | null; v: number | null; status: number } }
export interface WindGl { setFields(from: WindSampleField | null, to: WindSampleField | null): void; setMotion(paused: boolean, hidden: boolean): void; destroy(): void }

const STATE = 128, GRID = 128, LAYER = 'av-wind-particles', TRAIL_SIDE = 4096;
const FULL = `#version 300 es
out vec2 v_uv;
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));vec2 c=p*2.-1.;v_uv=c*.5+.5;gl_Position=vec4(c,0,1);}`;
/** Particle advection. `windAt` transcribes `sampleEncodedWindGrid`: texel centers, then skip alpha 0 before `* 200`. */
export const WIND_PARTICLE_UPDATE = `#version 300 es
precision highp float;uniform sampler2D u_state,u_a,u_b;uniform vec4 u_bounds,u_spawn;uniform float u_dt,u_zoom,u_mix,u_reset,u_world;out vec4 o;
vec2 merc(vec2 p){float r=p.y*.01745329251;return vec2((p.x+180.)/360.,.5-log(tan(.78539816339+r*.5))/6.28318530718);}
vec3 windAt(sampler2D tex,vec2 uv){vec2 p=uv*float(${GRID})-0.5;vec2 f=fract(p);ivec2 o=ivec2(floor(p));vec2 acc=vec2(0.0);float wsum=0.0;
 for(int dy=0;dy<2;dy++)for(int dx=0;dx<2;dx++){float w=(dx==0?1.0-f.x:f.x)*(dy==0?1.0-f.y:f.y);if(w==0.0)continue;
  vec4 s=texelFetch(tex,clamp(o+ivec2(dx,dy),ivec2(0),ivec2(${GRID - 1})),0);if(s.a>0.5){acc+=(s.rg*200.0-100.0)*w;wsum+=w;}}
 return wsum>0.0?vec3(acc/wsum,1.0):vec3(0.0);}
void main(){ivec2 p=ivec2(gl_FragCoord.xy);vec4 s=texelFetch(u_state,p,0);
 if(u_reset>0.||s.z<=0.){float n=fract(sin(dot(vec2(p)+s.w,vec2(12.9898,78.233)))*43758.5453);float m=fract(n*91.7);
  o=vec4(mix(u_spawn.x,u_spawn.z,n),mix(u_spawn.y,u_spawn.w,m),1.5+n*2.5,s.w+1.);return;}
 vec2 uv=vec2((s.x-u_bounds.x)/(u_bounds.z-u_bounds.x),(s.y-u_bounds.y)/(u_bounds.w-u_bounds.y));
 vec3 a=windAt(u_a,uv),b=windAt(u_b,uv);bool va=a.z>0.5,vb=b.z>0.5;
 bool alive=u_mix>=1.0?vb:(va||vb);
 if(!alive||uv.x<0.||uv.y<0.||uv.x>1.||uv.y>1.||s.x<u_spawn.x||s.y<u_spawn.y||s.x>u_spawn.z||s.y>u_spawn.w){o=vec4(s.xy,0,s.w);return;}
 vec2 w=u_mix>=1.0?b.xy:(va&&vb?mix(a.xy,b.xy,u_mix):(vb?b.xy:a.xy));
 float speed=length(w),boost=speed>0.&&speed<4.?sqrt(4./speed):1.,c=cos(s.y*.01745329251);
 float sec=u_dt*600.*exp2(9.-u_zoom)*c*boost,lat=s.y+w.y*sec/6371000./.01745329251,lon=s.x+w.x*sec/(6371000.*c)/.01745329251;
 if(abs(lat)>85.){o=vec4(s.xy,0,s.w);return;}
 vec2 stepPx=(merc(vec2(lon,lat))-merc(s.xy))*u_world;if(dot(stepPx,stepPx)>900.){o=vec4(s.xy,0,s.w);return;}
 o=vec4(lon,lat,s.z-u_dt,s.w);}`;
const LINES = `#version 300 es
precision highp float;uniform sampler2D u_prev,u_curr;uniform mat4 u_matrix;uniform float u_world,u_max,u_radius;uniform vec2 u_view;
flat out float v_len;out vec2 v_local;
vec2 mercator(vec2 lonlat){float r=lonlat.y*.01745329251;return vec2((lonlat.x+180.)/360.,.5-log(tan(.78539816339+r*.5))/6.28318530718);}
void main(){v_len=0.;v_local=vec2(0.);int corner=gl_VertexID%6,id=gl_VertexID/6,c=corner<3?corner:corner==3?2:corner==4?1:3;ivec2 p=ivec2(id&${STATE - 1},id>>${Math.round(Math.log2(STATE))});
 vec4 a=texelFetch(u_prev,p,0),b=texelFetch(u_curr,p,0);if(a.z<=0.||b.z<=0.){gl_Position=vec4(2,2,0,1);return;}
 vec2 pa=mercator(a.xy),pb=mercator(b.xy);vec4 ca=u_matrix*vec4(pa*u_world,0,1),cb=u_matrix*vec4(pb*u_world,0,1);
 vec2 na=ca.xy/ca.w,nb=cb.xy/cb.w,d=(na-nb)*u_view*.5;if(dot(d,d)>u_max*u_max){gl_Position=vec4(2,2,0,1);return;}
 float len=length(d),reach=u_radius+2.;vec2 px=2./u_view,dir=len>0.001?d/len:vec2(1.,0.);float side=c==1||c==3?1.:-1.;
 v_len=len;v_local=vec2((c>1?1.:-1.)*(len*.5+reach),side*reach);
 vec2 tip=(c>1?nb:na)+(c>1?-dir:dir)*reach*px,n=vec2(-dir.y,dir.x)*side*reach*px;vec4 clip=c>1?cb:ca;
 gl_Position=vec4((tip+n)*clip.w,clip.zw);}`;
const WHITE = `#version 300 es
precision highp float;flat in float v_len;in vec2 v_local;uniform float u_radius;out vec4 o;
void main(){float dist=length(vec2(max(0.,abs(v_local.x)-v_len*.5),v_local.y));float edge=clamp(fwidth(dist),.5,1.5);
 float a=.95*(1.-smoothstep(u_radius-edge,u_radius+edge,dist));o=vec4(a);}`;
/** Trail targets are R8, so coverage is red and the sampled alpha is 1. */
const BLIT = `#version 300 es
precision mediump float;uniform sampler2D u_tex;uniform vec2 u_shift;uniform float u_gain,u_bias;in vec2 v_uv;out vec4 o;
void main(){vec2 uv=v_uv-u_shift;float t=uv.x<0.||uv.y<0.||uv.x>1.||uv.y>1.?0.:texture(u_tex,uv).r;o=vec4(max(0.,t*u_gain-u_bias));}`;

/** One-byte trail targets. Two copies of a 4096² buffer are the 32 MiB canvas reserve. */
export function trailTargetSize(bufferWidth: number, bufferHeight: number, maxSide = TRAIL_SIDE): { width: number; height: number } {
  const width = Math.max(1, Math.round(bufferWidth)), height = Math.max(1, Math.round(bufferHeight)), side = Math.max(1, Math.round(maxSide));
  const scale = Math.min(1, side / width, side / height);
  return { width: Math.max(1, Math.min(side, Math.round(width * scale))), height: Math.max(1, Math.min(side, Math.round(height * scale))) };
}

const valid = (s: { u: number | null; v: number | null; status: number }) => (s.status & STATUS_MASK) === STATUS_VALID && s.u !== null && s.v !== null;
export const encodeWindByte = (v: number) => Math.max(0, Math.min(255, Math.round((v / 100 + 1) * 127.5)));
const decodeWindByte = (byte: number) => byte / 255 * 200 - 100;

export interface EncodedWind { u: number; v: number }

/** Bilinear sample of an encoded wind grid. Alpha 0 adds neither vector nor weight. */
export function sampleEncodedWindGrid(data: Uint8Array, uvX: number, uvY: number, grid = GRID): EncodedWind | null {
  const texelX = uvX * grid - 0.5, texelY = uvY * grid - 0.5, x0 = Math.floor(texelX), y0 = Math.floor(texelY);
  const fx = texelX - x0, fy = texelY - y0;
  let u = 0, v = 0, weight = 0;
  for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    const tap = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
    if (tap === 0) continue;
    const x = Math.max(0, Math.min(grid - 1, x0 + dx)), y = Math.max(0, Math.min(grid - 1, y0 + dy));
    const offset = (y * grid + x) * 4;
    if ((data[offset + 3] ?? 0) <= 127) continue;
    u += decodeWindByte(data[offset] ?? 0) * tap; v += decodeWindByte(data[offset + 1] ?? 0) * tap; weight += tap;
  }
  return weight > 0 ? { u: u / weight, v: v / weight } : null;
}

/** Mix two reconstructed fields. At t >= 1 only `to` remains, so a finished blend cannot carry the previous frame into a hole. */
export function mixWindVectors(from: EncodedWind | null, to: EncodedWind | null, t: number): EncodedWind | null {
  if (t >= 1) return to;
  if (from && to) return { u: from.u * (1 - t) + to.u * t, v: from.v * (1 - t) + to.v * t };
  return to ?? from;
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('Wind program unavailable');
  for (const [type, source] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Wind shader unavailable');
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Wind shader failed');
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Wind program failed');
  return program;
}

/** Draws particle trails into the map WebGL context. Returns null when the map cannot host a custom layer. */
export function attachWindGl(map: Map, onReady: (ok: boolean) => void): WindGl | null {
  if (typeof map.addLayer !== 'function' || typeof map.once !== 'function') return null;
  const state = { from: null as WindSampleField | null, to: null as WindSampleField | null, paused: false, hidden: true, added: false, ready: false, failed: false, destroyed: false };
  const report = (ok: boolean) => queueMicrotask(() => { if (!state.destroyed) onReady(ok); });
  let gl: WebGL2RenderingContext | null = null;
  let updateProg: WebGLProgram | null = null, lineProg: WebGLProgram | null = null, blitProg: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null, states: WebGLTexture[] = [], stateFbo: WebGLFramebuffer[] = [], winds: WebGLTexture[] = [], trails: WebGLTexture[] = [], trailFbo: WebGLFramebuffer[] = [];
  let index = 0, trail = 0, reset = 1, zoom = NaN, blendAt = 0, last = 0, shiftX = 0, shiftY = 0, sized = false;
  let bounds = { west: -180, south: -85, east: 180, north: 85 }, trailW = 1, trailH = 1, maxTrailSide = TRAIL_SIDE;
  const blank = new Uint8Array(new ArrayBuffer(GRID * GRID * 4)), pending = { a: blank, b: blank, dirty: false };

  function grid(field: WindSampleField | null): Uint8Array<ArrayBuffer> {
    const data = new Uint8Array(new ArrayBuffer(GRID * GRID * 4));
    if (!field) return data;
    for (let y = 0; y < GRID; y++) {
      const lat = bounds.south + (bounds.north - bounds.south) * (y + 0.5) / GRID;
      for (let x = 0; x < GRID; x++) {
        const sample = field.sample(lat, bounds.west + (bounds.east - bounds.west) * (x + 0.5) / GRID), i = (y * GRID + x) * 4;
        if (!valid(sample)) continue;
        data[i] = encodeWindByte(sample.u!); data[i + 1] = encodeWindByte(sample.v!); data[i + 3] = 255;
      }
    }
    return data;
  }
  function viewBounds(): typeof bounds | null {
    const box = map.getBounds?.();
    if (!box) return null;
    let west = box.getWest(), east = box.getEast();
    const south = box.getSouth(), north = box.getNorth();
    if (![west, east, south, north].every(Number.isFinite)) return null;
    if (east - west >= 360 || east <= west) { west = -180; east = 180; }
    const dx = Math.max(1, east - west) * 0.15, dy = Math.max(1, north - south) * 0.15;
    return { west: west - dx, east: east + dx, south: Math.max(-85, south - dy), north: Math.min(85, north + dy) };
  }
  function screenBounds(): typeof bounds | null {
    const box = map.getBounds?.();
    if (!box) return null;
    let west = box.getWest(), east = box.getEast();
    const south = box.getSouth(), north = box.getNorth();
    if (![west, east, south, north].every(Number.isFinite)) return null;
    if (east - west >= 360 || east <= west) { west = -180; east = 180; }
    return { west, east, south: Math.max(-85, south), north: Math.min(85, north) };
  }
  function inside(): boolean {
    const next = viewBounds();
    if (!next) return true;
    const cx = (next.west + next.east) / 2, cy = (next.south + next.north) / 2;
    return cx > bounds.west && cx < bounds.east && cy > bounds.south && cy < bounds.north;
  }
  function sizeTrail(): void {
    if (!gl) return;
    const canvas = map.getCanvas(), dpr = window.devicePixelRatio || 1;
    const { width: tw, height: th } = trailTargetSize(canvas.width || Math.round(canvas.clientWidth * dpr), canvas.height || Math.round(canvas.clientHeight * dpr), maxTrailSide);
    if (sized && tw === trailW && th === trailH) return;
    sized = true;
    trailW = tw; trailH = th;
    for (const texture of trails) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, tw, th, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    }
    reset = 1;
  }
  function uploadWind(): void {
    if (!gl || !pending.dirty) return;
    for (const [texture, data] of [[winds[0], pending.a], [winds[1], pending.b]] as const) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, GRID, GRID, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }
    pending.dirty = false;
  }
  function draw(program: WebGLProgram, mode: number, count: number): void {
    gl!.useProgram(program); gl!.bindVertexArray(vao!); gl!.drawArrays(mode, 0, count);
  }
  function releaseGl(): void {
    if (!gl) return;
    const context = gl;
    for (const texture of [...states, ...winds, ...trails]) context.deleteTexture(texture);
    for (const fbo of [...stateFbo, ...trailFbo]) context.deleteFramebuffer(fbo);
    if (vao) context.deleteVertexArray(vao);
    for (const program of [updateProg, lineProg, blitProg]) if (program) context.deleteProgram(program);
    gl = null; state.ready = false;
  }
  function frame(matrix: ArrayLike<number>): void {
    if (!gl || state.failed || !state.ready || state.hidden || !state.to) return;
    const now = performance.now(), dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
    if (state.from && now - blendAt >= PLAYBACK_STEP_MS) state.from = null;
    last = now;
    const nextZoom = map.getZoom();
    if (!inside() || nextZoom !== zoom) {
      const area = viewBounds();
      if (area) bounds = area;
      pending.a = grid(state.from ?? state.to); pending.b = grid(state.to); pending.dirty = true; reset = 1; zoom = nextZoom;
    }
    uploadWind(); sizeTrail();
    const update = updateProg!, blit = blitProg!, lines = lineProg!;
    const savedFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const savedVp = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const savedProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    const savedVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const savedCull = gl.isEnabled(gl.CULL_FACE);
    const savedMask = gl.getParameter(gl.COLOR_WRITEMASK) as [boolean, boolean, boolean, boolean];
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, stateFbo[1 - index]); gl.viewport(0, 0, STATE, STATE);
    gl.useProgram(update);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, states[index]);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, winds[0]);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, winds[1]);
    gl.uniform1i(gl.getUniformLocation(update, 'u_state'), 0);
    gl.uniform1i(gl.getUniformLocation(update, 'u_a'), 1);
    gl.uniform1i(gl.getUniformLocation(update, 'u_b'), 2);
    gl.uniform4f(gl.getUniformLocation(update, 'u_bounds'), bounds.west, bounds.south, bounds.east, bounds.north);
    const spawn = screenBounds() ?? bounds;
    gl.uniform4f(gl.getUniformLocation(update, 'u_spawn'), spawn.west, spawn.south, spawn.east, spawn.north);
    gl.uniform1f(gl.getUniformLocation(update, 'u_dt'), state.paused ? 0 : dt);
    gl.uniform1f(gl.getUniformLocation(update, 'u_zoom'), nextZoom);
    gl.uniform1f(gl.getUniformLocation(update, 'u_world'), 512 * 2 ** nextZoom);
    gl.uniform1f(gl.getUniformLocation(update, 'u_mix'), state.from ? Math.min(1, (now - blendAt) / PLAYBACK_STEP_MS) : 1);
    gl.uniform1f(gl.getUniformLocation(update, 'u_reset'), reset);
    draw(update, gl.TRIANGLES, 3);
    const point = map.project([0, 0]);
    const width = Math.max(1, map.getCanvas().clientWidth), height = Math.max(1, map.getCanvas().clientHeight);
    const sx = (point.x - shiftX) / width, sy = (shiftY - point.y) / height;
    const jump = Math.hypot(sx, sy) > 0.5;
    shiftX = point.x; shiftY = point.y;
    const nextTrail = 1 - trail;
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, trailFbo[nextTrail]); gl.viewport(0, 0, trailW, trailH);
    gl.useProgram(blit);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, trails[trail]);
    gl.uniform1i(gl.getUniformLocation(blit, 'u_tex'), 0);
    gl.uniform2f(gl.getUniformLocation(blit, 'u_shift'), reset || jump ? 0 : sx, reset || jump ? 0 : sy);
    gl.uniform1f(gl.getUniformLocation(blit, 'u_gain'), reset || jump ? 0 : Math.exp(-dt * WIND_TRAIL_FADE));
    gl.uniform1f(gl.getUniformLocation(blit, 'u_bias'), 0);
    draw(blit, gl.TRIANGLES, 3);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(lines);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, states[index]);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, states[1 - index]);
    gl.uniform1i(gl.getUniformLocation(lines, 'u_prev'), 0);
    gl.uniform1i(gl.getUniformLocation(lines, 'u_curr'), 1);
    gl.uniform1f(gl.getUniformLocation(lines, 'u_world'), 512 * 2 ** nextZoom);
    gl.uniform2f(gl.getUniformLocation(lines, 'u_view'), trailW, trailH);
    gl.uniform1f(gl.getUniformLocation(lines, 'u_max'), 30 * trailW / Math.max(1, map.getCanvas().clientWidth));
    gl.uniformMatrix4fv(gl.getUniformLocation(lines, 'u_matrix'), false, matrix instanceof Float32Array ? matrix : Float32Array.from(matrix));
    gl.uniform1f(gl.getUniformLocation(lines, 'u_radius'), windTrailWidth(nextZoom) * 0.5 * trailW / width);
    draw(lines, gl.TRIANGLES, Math.min(STATE * STATE, windParticleCount(width, height, nextZoom)) * 6);
    index = 1 - index; trail = nextTrail; reset = 0;
    gl.colorMask(savedMask[0], savedMask[1], savedMask[2], savedMask[3]);
    if (savedCull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, savedFbo); gl.viewport(savedVp[0]!, savedVp[1]!, savedVp[2]!, savedVp[3]!);
    gl.useProgram(savedProgram); gl.bindVertexArray(savedVao); gl.bindTexture(gl.TEXTURE_2D, null);
  }
  function present(): void {
    if (!gl || state.failed || !state.ready || state.hidden || !state.to) return;
    const savedProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    const savedVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const blit = blitProg!;
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(blit);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, trails[trail]);
    gl.uniform1i(gl.getUniformLocation(blit, 'u_tex'), 0);
    gl.uniform2f(gl.getUniformLocation(blit, 'u_shift'), 0, 0);
    gl.uniform1f(gl.getUniformLocation(blit, 'u_gain'), WIND_TRAIL_GAIN);
    gl.uniform1f(gl.getUniformLocation(blit, 'u_bias'), WIND_TRAIL_BIAS);
    draw(blit, gl.TRIANGLES, 3);
    gl.useProgram(savedProgram); gl.bindVertexArray(savedVao); gl.bindTexture(gl.TEXTURE_2D, null);
    if (!state.paused && document.visibilityState !== 'hidden') map.triggerRepaint();
  }
  const layer: CustomLayerInterface = {
    id: LAYER, type: 'custom', renderingMode: '2d',
    onAdd(_map, context) {
      try { releaseGl(); } catch { gl = null; state.ready = false; }
      gl = context;
      maxTrailSide = Math.min(TRAIL_SIDE, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
      sized = false;
      if (state.destroyed) return;
      try {
        if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('Wind float target unavailable');
        updateProg = compile(gl, FULL, WIND_PARTICLE_UPDATE); lineProg = compile(gl, LINES, WHITE); blitProg = compile(gl, FULL, BLIT);
        vao = gl.createVertexArray()!;
        const tex = (filter: number) => {
          const texture = gl!.createTexture()!;
          gl!.bindTexture(gl!.TEXTURE_2D, texture);
          gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, filter);
          gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, filter);
          gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
          gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
          return texture;
        };
        states = [tex(gl.NEAREST), tex(gl.NEAREST)];
        stateFbo = states.map(texture => {
          gl!.bindTexture(gl!.TEXTURE_2D, texture);
          gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA32F, STATE, STATE, 0, gl!.RGBA, gl!.FLOAT, new Float32Array(STATE * STATE * 4));
          const fbo = gl!.createFramebuffer()!;
          gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
          gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, texture, 0);
          if (gl!.checkFramebufferStatus(gl!.FRAMEBUFFER) !== gl!.FRAMEBUFFER_COMPLETE) throw new Error('Wind state target incomplete');
          return fbo;
        });
        winds = [tex(gl.NEAREST), tex(gl.NEAREST)];
        for (const texture of winds) { gl.bindTexture(gl.TEXTURE_2D, texture); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, GRID, GRID, 0, gl.RGBA, gl.UNSIGNED_BYTE, blank); }
        trails = [tex(gl.LINEAR), tex(gl.LINEAR)];
        trailFbo = trails.map(texture => {
          const fbo = gl!.createFramebuffer()!;
          gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
          gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, texture, 0);
          return fbo;
        });
        sizeTrail();
        for (const fbo of trailFbo) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Wind trail target incomplete');
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        state.ready = true; report(true); map.triggerRepaint();
      } catch {
        state.failed = true; report(false);
      }
    },
    onRemove() { try { releaseGl(); } catch { gl = null; state.ready = false; } },
    prerender(_context, options) {
      try { frame(options.modelViewProjectionMatrix as unknown as ArrayLike<number>); }
      catch { state.failed = true; report(false); }
    },
    render() { try { present(); } catch { state.failed = true; report(false); } }
  };
  const raise = () => {
    if (!state.added || !map.getLayer(LAYER)) return;
    const layers = map.getStyle()?.layers;
    if (layers && layers[layers.length - 1]?.id !== LAYER) map.moveLayer(LAYER);
  };
  const mount = () => {
    if (state.destroyed || state.added) return;
    state.added = true;
    try { map.addLayer(layer); raise(); }
    catch { state.failed = true; report(false); }
  };
  for (const event of ['idle', 'styledata'] as const) map.on(event, raise);
  if (map.isStyleLoaded?.()) mount();
  else map.once('style.load', mount);
  return {
    setFields(from, to) {
      if (state.from === from && state.to === to) { if (state.ready && !state.hidden) map.triggerRepaint(); return; }
      state.from = from; state.to = to; blendAt = performance.now();
      if (Number.isNaN(zoom)) { const area = viewBounds(); if (area) bounds = area; }
      pending.a = grid(from ?? to); pending.b = grid(to); pending.dirty = true;
      if (state.ready) map.triggerRepaint();
    },
    setMotion(paused, hidden) { state.paused = paused; state.hidden = hidden; if (!hidden && state.ready) map.triggerRepaint(); },
    destroy() {
      state.destroyed = true; state.to = null;
      for (const event of ['idle', 'styledata'] as const) map.off(event, raise);
      if (state.added && map.getLayer(LAYER)) map.removeLayer(LAYER);
    }
  };
}
