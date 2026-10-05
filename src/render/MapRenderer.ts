import type { Palette } from '../formats/palette';
import { ATLAS_SIZE, type TileAtlas } from './atlas';

export interface Camera {
  x: number; // world point at the viewport centre
  y: number;
  zoom: number; // device pixels per world pixel
}

export const enum InstanceFlag {
  Shadow = 1,
  Highlight = 2,
  Dim = 4,
  Ghost = 8,
  /** Floor tile: solid-edged when zoomed out (see the fragment shader). */
  Floor = 256,
  Preview = 512,
}

/** Instance flag bits for a sprite layer's blend (a COF draw effect, or -1 for solid). */
export function blendFlag(blend: number): number {
  return blend < 0 ? 0 : (Math.min(blend, 6) + 1) << 4;
}

export interface Instance {
  x: number;
  y: number;
  w: number;
  h: number;
  u: number;
  v: number;
  layer: number;
  flags: number;
}

const FLOATS_PER_INSTANCE = 8;

const VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aDst;   // world x, y, w, h
layout(location=2) in vec2 aSrc;   // atlas texel u, v
layout(location=3) in vec2 aMeta;  // layer, flags
uniform vec2 uViewport;            // device pixels
uniform vec3 uCamera;              // x, y, zoom
out vec2 vTex;
flat out vec4 vRect;  // the instance's texels in the atlas: u0, v0, u1, v1 (exclusive)
flat out float vLayer;
flat out int vFlags;
out vec2 vWorld;
void main() {
  vec2 world = aDst.xy + aCorner * aDst.zw;
  vWorld = world;
  // The centre on a whole device pixel (an odd-sized canvas would put it on half of one): tile pixels then meet on
  // pixel edges and each screen pixel samples the middle of a tile pixel. On a half pixel every sample sits on an edge
  // between two tile pixels, and drivers that round it the other way (Mesa on Linux) double some and drop others.
  vec2 screen = (world - uCamera.xy) * uCamera.z + floor(uViewport * 0.5);
  gl_Position = vec4(screen / uViewport * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
  vTex = aSrc + aCorner * aDst.zw;
  vRect = vec4(aSrc, aSrc + aDst.zw);
  vLayer = aMeta.x;
  vFlags = int(aMeta.y);
}`;

/** Objects' lights drawn at once (the shader loops over them per pixel): those nearest the view. */
export const MAX_LIGHTS = 48;

/** A light in the scene: world position, radius in sub-tiles (as a player's light radius), colour 0-255. */
export interface SceneLight {
  x: number;
  y: number;
  radius: number;
  rgb: [number, number, number];
}

/** World pixels per sub-tile of light radius, the most along either screen axis (see the shader's falloff). */
const LIGHT_REACH = 16 * Math.SQRT2;

/** The lights reaching into the view, nearest its centre first, at most MAX_LIGHTS. */
export function nearestLights(lights: SceneLight[], camera: { x: number; y: number; zoom: number }, width: number, height: number): SceneLight[] {
  const hw = width / 2 / camera.zoom, hh = height / 2 / camera.zoom;
  return lights
    .filter((l) => Math.abs(l.x - camera.x) < hw + l.radius * LIGHT_REACH && Math.abs(l.y - camera.y) < hh + l.radius * LIGHT_REACH)
    .map((l) => ({ l, d: (l.x - camera.x) ** 2 + (l.y - camera.y) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_LIGHTS)
    .map((x) => x.l);
}

// Palette-indexed pixels can't use the GPU's texture filtering, so the shader resolves the palette itself. At 100%
// and closer each screen pixel shows one tile pixel (exactly what the game draws). Zoomed out, a screen pixel covers
// several tile pixels: they are averaged in linear light (a proper downscale, no shimmer or dropped pixels), and the
// pixel is drawn solid when at least half of it is covered, so neighbouring floor tiles still meet without seams.
const FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uAtlas;
uniform sampler2D uPalette;
uniform vec3 uLight;               // the level's ambient light (Levels.txt Intensity × Red/Green/Blue), 1 = unlit
uniform vec3 uGlow;                // a player's light: world x, y and radius in sub-tiles (0 = none)
uniform vec4 uLights[${MAX_LIGHTS}];        // objects' lights: world x, y, radius in sub-tiles
uniform vec3 uLightRgb[${MAX_LIGHTS}];      // and their colours (0-1)
uniform int uLightCount;
in vec2 vTex;
in vec2 vWorld;
flat in vec4 vRect;
flat in float vLayer;
flat in int vFlags;
out vec4 outColor;

int indexAt(vec2 t) {
  ivec2 p = ivec2(clamp(floor(t), vRect.xy, vRect.zw - 1.0));
  return int(texelFetch(uAtlas, ivec3(p, int(vLayer)), 0).r * 255.0 + 0.5);
}
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }

void main() {
  vec2 fw = fwidth(vTex);
  float texelsPerPixel = max(fw.x, fw.y);
  vec3 rgb;
  float coverage;
  if (texelsPerPixel <= 1.01) {
    int i = indexAt(vTex);
    if (i == 0) discard;
    rgb = texelFetch(uPalette, ivec2(i, 0), 0).rgb;
    coverage = 1.0;
  } else {
    int n = int(clamp(ceil(texelsPerPixel), 2.0, 6.0));
    vec2 stepv = fw / float(n);
    vec2 origin = vTex - fw * 0.5 + stepv * 0.5;
    vec3 sum = vec3(0.0);
    float hits = 0.0;
    for (int y = 0; y < 6; y++) {
      if (y >= n) break;
      for (int x = 0; x < 6; x++) {
        if (x >= n) break;
        int i = indexAt(origin + stepv * vec2(float(x), float(y)));
        if (i == 0) continue;
        sum += toLinear(texelFetch(uPalette, ivec2(i, 0), 0).rgb);
        hits += 1.0;
      }
    }
    coverage = hits / float(n * n);
    if (hits == 0.0) discard;
    // Floors are drawn solid where at least half covered, so neighbouring floor tiles meet without seams. Everything
    // else fades with its coverage, so thin details (railings, posts) thin out instead of vanishing when zoomed out.
    if ((vFlags & 256) != 0) {
      if (coverage < 0.5) discard;
      coverage = 1.0;
    }
    rgb = toSrgb(sum / hits);
  }
  // The player's light radius brightens the level's light around them, measured in sub-tiles on the ground (an
  // ellipse on screen), full near them and fading to the level's light at the edge.
  vec3 light = uLight;
  if (uGlow.z > 0.0) {
    vec2 d = vWorld - uGlow.xy;
    float a = (d.x / 16.0 + d.y / 8.0) * 0.5;
    float b = (d.y / 8.0 - d.x / 16.0) * 0.5;
    light = mix(vec3(1.0), uLight, smoothstep(0.55, 1.0, length(vec2(a, b)) / uGlow.z));
  }
  // Objects' lights (torches, fires, candles…): the same falloff, in their colour; where lights meet, the brightest.
  for (int k = 0; k < ${MAX_LIGHTS}; k++) {
    if (k >= uLightCount) break;
    vec2 d = vWorld - uLights[k].xy;
    float a = (d.x / 16.0 + d.y / 8.0) * 0.5;
    float b = (d.y / 8.0 - d.x / 16.0) * 0.5;
    light = max(light, mix(uLightRgb[k], uLight, smoothstep(0.55, 1.0, length(vec2(a, b)) / uLights[k].z)));
  }
  rgb *= light;
  // Output is premultiplied (blendFunc ONE, ONE_MINUS_SRC_ALPHA), so alpha 0 with colour means "add".
  if ((vFlags & 1) != 0) {
    vec3 tint = (vFlags & 2) != 0 ? vec3(1.0, 0.78, 0.3) : (vFlags & 512) != 0 ? vec3(0.3, 0.8, 1.0) : vec3(0.0);
    outColor = vec4(tint, 0.45 * coverage); return;
  }
  if ((vFlags & 2) != 0) rgb = mix(rgb, vec3(1.0, 0.78, 0.3), 0.35);
  else if ((vFlags & 512) != 0) rgb = mix(rgb, vec3(0.3, 0.8, 1.0), 0.40);
  if ((vFlags & 4) != 0) rgb *= 0.35;
  float a = ((vFlags & 8) != 0 ? 0.6 : 1.0) * coverage;
  // Sprite layer blend (bits 4-7): 0 solid, else Diablo II's draw effect + 1.
  int mode = (vFlags >> 4) & 15;
  if (mode == 1) a *= 0.75;
  else if (mode == 2) a *= 0.5;
  else if (mode == 3) a *= 0.25;
  else if (mode == 4 || mode == 5) { outColor = vec4(rgb * a, 0.0); return; }             // luminance / additive: glow
  else if (mode == 6) { float l = dot(rgb, vec3(0.299, 0.587, 0.114)); outColor = vec4(0.0, 0.0, 0.0, (1.0 - l) * a); return; } // multiply (darken)
  else if (mode == 7) { float m = max(rgb.r, max(rgb.g, rgb.b)); outColor = vec4(rgb * m * a, m * a); return; }  // black is transparent
  outColor = vec4(rgb * a, a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
  return s;
}

/** Draws tile instances from a TileAtlas with WebGL2 in a single instanced call. */
export class MapRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly atlasTex: WebGLTexture;
  private readonly paletteTex: WebGLTexture;
  private readonly uViewport: WebGLUniformLocation;
  private readonly uCamera: WebGLUniformLocation;
  private instanceCount = 0;
  private atlasLayers = 0;
  private uploadedPages = 0;
  private uploadedAtlas: TileAtlas | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
    this.program = p;
    this.uViewport = gl.getUniformLocation(p, 'uViewport')!;
    this.uCamera = gl.getUniformLocation(p, 'uCamera')!;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    const stride = FLOATS_PER_INSTANCE * 4;
    const attrs: [number, number, number][] = [
      [1, 4, 0],
      [2, 2, 16],
      [3, 2, 24],
    ];
    for (const [loc, size, offset] of attrs) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);

    this.atlasTex = gl.createTexture()!;
    this.paletteTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    for (const t of [gl.TEXTURE_2D]) {
      gl.texParameteri(t, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(t, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
  }

  setPalette(palette: Palette): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, palette);
  }

  /** Uploads atlas pages; call after adding tiles to the atlas. Re-allocates the texture array when it grows. */
  syncAtlas(atlas: TileAtlas): void {
    const gl = this.gl;
    const n = atlas.pages.length;
    if (n === 0) return;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // A new atlas (another map was opened) must be uploaded from scratch: its pages reuse the texture layers. Otherwise
    // resume at the last page uploaded, which may have gained tiles since (only the newest page is ever appended to).
    let from = this.uploadedAtlas === atlas ? Math.max(0, this.uploadedPages - 1) : 0;
    this.uploadedAtlas = atlas;
    if (n > this.atlasLayers) {
      this.atlasLayers = Math.max(n, this.atlasLayers * 2, 2);
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8, ATLAS_SIZE, ATLAS_SIZE, this.atlasLayers, 0, gl.RED, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      from = 0;
    }
    for (let i = from; i < n; i++) {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, ATLAS_SIZE, ATLAS_SIZE, 1, gl.RED, gl.UNSIGNED_BYTE, atlas.pages[i]);
    }
    this.uploadedPages = n;
  }

  setInstances(instances: Instance[]): void {
    const n = instances.length;
    // Reuse the array while it's big enough (rebuilds happen every animation frame on maps with animated objects).
    if (!this.data || this.data.length < n * FLOATS_PER_INSTANCE) this.data = new Float32Array(Math.max(n, 1024) * FLOATS_PER_INSTANCE * 1.25);
    const data = this.data;
    for (let i = 0, o = 0; i < n; i++, o += FLOATS_PER_INSTANCE) {
      const it = instances[i];
      data[o] = it.x;
      data[o + 1] = it.y;
      data[o + 2] = it.w;
      data[o + 3] = it.h;
      data[o + 4] = it.u;
      data[o + 5] = it.v;
      data[o + 6] = it.layer;
      data[o + 7] = it.flags;
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    if (n * FLOATS_PER_INSTANCE <= this.bufferFloats) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * FLOATS_PER_INSTANCE);
    else {
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      this.bufferFloats = data.length;
    }
    this.instanceCount = n;
  }

  /**
   * Changes the flags (highlight, hover…) of some instances without rebuilding the rest: hovering and selecting only
   * touch the tiles whose emphasis changed. `changes` maps instance index → new flags.
   */
  setFlags(changes: Map<number, number>): void {
    const data = this.data;
    if (!data || !changes.size) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    let lo = Infinity;
    let hi = -1;
    for (const [i, f] of changes) {
      if (i >= this.instanceCount) continue;
      data[i * FLOATS_PER_INSTANCE + 7] = f;
      lo = Math.min(lo, i);
      hi = Math.max(hi, i);
    }
    if (hi < 0) return;
    // Few scattered changes: one small upload each; else one upload of the span.
    if (changes.size <= 64)
      for (const i of changes.keys()) {
        if (i < this.instanceCount) gl.bufferSubData(gl.ARRAY_BUFFER, (i * FLOATS_PER_INSTANCE + 7) * 4, data, i * FLOATS_PER_INSTANCE + 7, 1);
      }
    else gl.bufferSubData(gl.ARRAY_BUFFER, lo * FLOATS_PER_INSTANCE * 4, data, lo * FLOATS_PER_INSTANCE, (hi - lo + 1) * FLOATS_PER_INSTANCE);
  }

  /**
   * Replaces some instances in place (animation frames: an object's parts or an animated floor tile), uploading only
   * the span they cover.
   */
  patchInstances(updates: { index: number; inst: Instance }[]): void {
    const data = this.data;
    if (!data || !updates.length) return;
    let lo = Infinity;
    let hi = -1;
    for (const { index, inst } of updates) {
      if (index >= this.instanceCount) continue;
      const o = index * FLOATS_PER_INSTANCE;
      data[o] = inst.x;
      data[o + 1] = inst.y;
      data[o + 2] = inst.w;
      data[o + 3] = inst.h;
      data[o + 4] = inst.u;
      data[o + 5] = inst.v;
      data[o + 6] = inst.layer;
      data[o + 7] = inst.flags;
      lo = Math.min(lo, index);
      hi = Math.max(hi, index);
    }
    if (hi < 0) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, lo * FLOATS_PER_INSTANCE * 4, data, lo * FLOATS_PER_INSTANCE, (hi - lo + 1) * FLOATS_PER_INSTANCE);
  }

  /** The instance data last uploaded (reused between rebuilds). */
  private data: Float32Array | null = null;
  /** Size of the GPU buffer, in floats. */
  private bufferFloats = 0;

  /** Multiplies every drawn colour: the level's light when previewing it, else 1 (tiles as stored). */
  light: [number, number, number] = [1, 1, 1];
  /** A player's light around a world point: x, y, radius in sub-tiles (0 = none). */
  glow: [number, number, number] = [0, 0, 0];
  /** Objects' lights (world position, radius in sub-tiles, colour 0-255); those nearest the view are drawn. */
  lights: SceneLight[] = [];

  draw(camera: Camera, background: [number, number, number]): void {
    const gl = this.gl;
    const { width, height } = this.canvas;
    gl.viewport(0, 0, width, height);
    gl.clearColor(background[0], background[1], background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.instanceCount === 0 || this.atlasLayers === 0) return;

    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied: also allows additive (glow) layers
    gl.uniform2f(this.uViewport, width, height);
    // Snap the camera to whole device pixels so tiles don't shimmer while panning.
    const snap = (v: number) => Math.round(v * camera.zoom) / camera.zoom;
    gl.uniform3f(this.uCamera, snap(camera.x), snap(camera.y), camera.zoom);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTex);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uAtlas'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uPalette'), 1);
    gl.uniform3f(gl.getUniformLocation(this.program, 'uLight'), ...this.light);
    gl.uniform3f(gl.getUniformLocation(this.program, 'uGlow'), ...this.glow);
    const near = nearestLights(this.lights, camera, width, height);
    const pos = new Float32Array(MAX_LIGHTS * 4), rgb = new Float32Array(MAX_LIGHTS * 3);
    near.forEach((l, k) => {
      pos.set([l.x, l.y, l.radius, 0], k * 4);
      rgb.set([l.rgb[0] / 255, l.rgb[1] / 255, l.rgb[2] / 255], k * 3);
    });
    gl.uniform4fv(gl.getUniformLocation(this.program, 'uLights'), pos);
    gl.uniform3fv(gl.getUniformLocation(this.program, 'uLightRgb'), rgb);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uLightCount'), near.length);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.instanceCount);
    gl.bindVertexArray(null);
  }
}
