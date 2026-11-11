import type { VisualStyleId } from '@/types/gev';

export interface ShaderUniformDef {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step?: number;
}

export interface ShaderPresetSpec {
  id: Exclude<VisualStyleId, 'normal'>;
  label: string;
  shortLabel: string;
  hotkey: string;
  description: string;
  uniforms: ShaderUniformDef[];
  fragmentShader: string;
}

export const SHARPEN_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D colorTexture;
  uniform vec2 colorTextureDimensions;
  uniform float amount;
  in vec2 v_textureCoordinates;

  void main() {
    vec2 uv = v_textureCoordinates;
    vec2 texel = 1.0 / colorTextureDimensions;
    vec4 center = texture(colorTexture, uv);
    vec4 blur = (
      texture(colorTexture, uv + vec2(-texel.x, -texel.y)) +
      texture(colorTexture, uv + vec2( 0.0,     -texel.y)) +
      texture(colorTexture, uv + vec2( texel.x, -texel.y)) +
      texture(colorTexture, uv + vec2(-texel.x,  0.0))     +
      center +
      texture(colorTexture, uv + vec2( texel.x,  0.0))     +
      texture(colorTexture, uv + vec2(-texel.x,  texel.y)) +
      texture(colorTexture, uv + vec2( 0.0,      texel.y)) +
      texture(colorTexture, uv + vec2( texel.x,  texel.y))
    ) / 9.0;
    vec4 sharpened = center + (center - blur) * amount;
    out_FragColor = vec4(clamp(sharpened.rgb, 0.0, 1.0), center.a);
  }
`;

export const SHADER_PRESETS: Record<Exclude<VisualStyleId, 'normal'>, ShaderPresetSpec> = {
  retro: {
    id: 'retro',
    label: 'CRT',
    shortLabel: 'CRT',
    hotkey: '2',
    description: 'Green/amber phosphor CRT with Bayer dithering, scanlines, and barrel curvature.',
    uniforms: [
      { key: 'pixelation', label: 'Pixelation', default: 1.0, min: 1, max: 10, step: 0.25 },
      { key: 'distortion', label: 'Distortion', default: 0, min: 0, max: 1, step: 0.02 },
      { key: 'instability', label: 'Instability', default: 0.42, min: 0, max: 1, step: 0.02 },
    ],
    fragmentShader: /* glsl */ `
      uniform sampler2D colorTexture;
      uniform vec2 colorTextureDimensions;
      uniform float intensity;
      uniform float pixelation;
      uniform float distortion;
      uniform float instability;
      uniform float time;
      in vec2 v_textureCoordinates;

      float hash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      float bayer8(vec2 pos) {
        ivec2 p = ivec2(mod(pos, 8.0));
        int index = p.x + p.y * 8;
        int bayer[64] = int[64](
           0, 32,  8, 40,  2, 34, 10, 42,
          48, 16, 56, 24, 50, 18, 58, 26,
          12, 44,  4, 36, 14, 46,  6, 38,
          60, 28, 52, 20, 62, 30, 54, 22,
           3, 35, 11, 43,  1, 33,  9, 41,
          51, 19, 59, 27, 49, 17, 57, 25,
          15, 47,  7, 39, 13, 45,  5, 37,
          63, 31, 55, 23, 61, 29, 53, 21
        );
        return float(bayer[index]) / 64.0;
      }

      vec2 barrelDistort(vec2 uv, float strength) {
        vec2 centered = uv * 2.0 - 1.0;
        float r2 = dot(centered, centered);
        float distort = 1.0 + r2 * strength * 0.4;
        centered *= distort;
        return centered * 0.5 + 0.5;
      }

      void main() {
        vec2 uv = v_textureCoordinates;
        vec2 dims = colorTextureDimensions;
        vec2 texel = 1.0 / dims;

        float dist = distortion * intensity;
        vec2 distUV = barrelDistort(uv, dist);
        if (distUV.x < 0.0 || distUV.x > 1.0 || distUV.y < 0.0 || distUV.y > 1.0) {
          out_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
          return;
        }

        float lineY = floor(distUV.y * dims.y);
        float jitterSeed = hash(vec2(lineY, floor(time * 8.0)));
        float jitterActive = step(0.97 - instability * 0.04, jitterSeed);
        float jitterAmount = (hash(vec2(lineY * 7.0, floor(time * 12.0))) - 0.5) *
                             0.008 * instability * jitterActive * intensity;
        vec2 jitteredUV = distUV + vec2(jitterAmount, 0.0);

        vec2 centered = jitteredUV - 0.5;
        float caStrength = length(centered) * 0.008 * intensity;
        float r = texture(colorTexture, jitteredUV + centered * caStrength).r;
        float g = texture(colorTexture, jitteredUV).g;
        float b = texture(colorTexture, jitteredUV - centered * caStrength).b;
        vec4 color = vec4(r, g, b, 1.0);

        float pixSize = mix(1.0, pixelation, intensity);
        vec2 pixelUV = floor(jitteredUV * dims / pixSize) * pixSize / dims;
        vec4 pixelColor = texture(colorTexture, mix(jitteredUV, pixelUV, intensity));
        color = mix(color, pixelColor, 0.7 * intensity);

        vec2 ditherCoord = jitteredUV * dims / pixSize;
        float dither = bayer8(ditherCoord) - 0.5;
        vec3 dithered = color.rgb + dither * 0.12 * intensity;

        float levels = mix(256.0, 10.0, intensity);
        vec3 posterized = floor(dithered * levels + 0.5) / levels;

        float gray = dot(posterized, vec3(0.299, 0.587, 0.114));
        vec3 saturated = mix(vec3(gray), posterized, 1.0 + 0.3 * intensity);

        float subpixelX = mod(distUV.x * dims.x, 3.0);
        vec3 subpixelMask = vec3(
          smoothstep(0.0, 0.8, 1.0 - abs(subpixelX - 0.5)),
          smoothstep(0.0, 0.8, 1.0 - abs(subpixelX - 1.5)),
          smoothstep(0.0, 0.8, 1.0 - abs(subpixelX - 2.5))
        );
        float subpixelStrength = smoothstep(2.0, 6.0, pixSize) * 0.3 * intensity;
        vec3 withSubpixels = mix(saturated, saturated * (subpixelMask * 0.7 + 0.3), subpixelStrength);

        vec2 pixelCenter = fract(distUV * dims / pixSize);
        float blockEdge = smoothstep(0.0, 0.08, min(min(pixelCenter.x, 1.0 - pixelCenter.x),
                                                      min(pixelCenter.y, 1.0 - pixelCenter.y)));
        vec3 result = withSubpixels * mix(1.0, blockEdge * 0.15 + 0.85, intensity);

        float scanY = distUV.y * dims.y;
        float scanline = pow(sin(scanY * 1.0 + time * 2.5) * 0.5 + 0.5, 1.5);
        float scanFade = 0.35 * intensity;
        result *= mix(1.0, scanline * scanFade + (1.0 - scanFade), intensity);

        vec3 ghost = texture(colorTexture, jitteredUV - vec2(texel.x * 2.0, 0.0)).rgb;
        float ghostGray = dot(ghost, vec3(0.299, 0.587, 0.114));
        result = mix(result, result + vec3(ghostGray) * 0.08, instability * intensity);

        float flicker = 1.0 - (sin(time * 188.5) * 0.5 + 0.5) * 0.03 * instability * intensity;
        result *= flicker;

        float glitchSeed = hash(vec2(floor(time * 2.0), 0.0));
        float glitchLine = step(0.92 - instability * 0.08, glitchSeed);
        if (glitchLine > 0.0) {
          float glitchY = hash(vec2(floor(time * 2.0), 1.0));
          float glitchHit = 1.0 - smoothstep(0.0, 0.003, abs(distUV.y - glitchY));
          result += glitchHit * 0.3 * instability * intensity;
        }

        result = mix(result, result * vec3(1.02, 1.0, 0.94), 0.4 * intensity);
        vec2 vigUV = distUV * (1.0 - distUV);
        float vig = clamp(pow(vigUV.x * vigUV.y * 20.0, 0.25 + 0.15 * intensity), 0.0, 1.0);
        result *= mix(1.0, vig, 0.6 * intensity);

        out_FragColor = vec4(mix(texture(colorTexture, uv).rgb, result, intensity), 1.0);
      }
    `,
  },

  surveillance: {
    id: 'surveillance',
    label: 'NVG',
    shortLabel: 'NVG',
    hotkey: '3',
    description: 'PVS-14 P43 phosphor green night-vision intensifier with tube vignette and bloom.',
    uniforms: [
      { key: 'gain', label: 'Gain', default: 0.18, min: 0, max: 1, step: 0.02 },
      { key: 'bloom', label: 'Bloom', default: 0.22, min: 0, max: 1, step: 0.02 },
      { key: 'scanlineStr', label: 'Scanlines', default: 0.96, min: 0, max: 1, step: 0.02 },
      { key: 'pixelation', label: 'Pixelation', default: 1.0, min: 1, max: 6, step: 0.25 },
    ],
    fragmentShader: /* glsl */ `
      uniform sampler2D colorTexture;
      uniform vec2 colorTextureDimensions;
      uniform float intensity;
      uniform float time;
      uniform float gain;
      uniform float bloom;
      uniform float scanlineStr;
      uniform float pixelation;
      in vec2 v_textureCoordinates;

      float hash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      float valueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      vec2 barrelDistort(vec2 uv, float strength) {
        vec2 c = uv * 2.0 - 1.0;
        float r2 = dot(c, c);
        c *= 1.0 + r2 * strength * 0.5 + r2 * r2 * strength * 0.15;
        return c * 0.5 + 0.5;
      }

      float honeycomb(vec2 uv) {
        vec2 dims = colorTextureDimensions;
        float scale = min(dims.x, dims.y) * 0.008;
        vec2 p = uv * dims * scale;
        vec2 r = vec2(1.0, 1.732);
        vec2 h = r * 0.5;
        vec2 a = mod(p, r) - h;
        vec2 b = mod(p - h, r) - h;
        vec2 gv = dot(a, a) < dot(b, b) ? a : b;
        float d = max(abs(gv.x), abs(gv.y * 0.577 + abs(gv.x) * 0.5));
        return smoothstep(0.4, 0.45, d);
      }

      float crosshair(vec2 uv) {
        vec2 c = uv - 0.5;
        float h = smoothstep(0.001, 0.0004, abs(c.y)) * step(0.01, abs(c.x)) * step(abs(c.x), 0.025);
        float v = smoothstep(0.001, 0.0004, abs(c.x)) * step(0.01, abs(c.y)) * step(abs(c.y), 0.025);
        return clamp(h + v, 0.0, 1.0);
      }

      void main() {
        vec2 uv = v_textureCoordinates;
        vec2 dims = colorTextureDimensions;
        vec2 texel = 1.0 / dims;

        vec2 distUV = barrelDistort(uv, 0.5 * intensity);
        vec2 centered = uv * 2.0 - 1.0;
        centered.x *= dims.x / dims.y;
        float radius = length(centered);
        float tubeMask = pow(1.0 - smoothstep(0.6, 1.05, radius), 0.7);
        float tubeShading = max(1.0 - radius * radius * 0.3, 0.0);

        if (tubeMask < 0.001 || distUV.x < 0.0 || distUV.x > 1.0 || distUV.y < 0.0 || distUV.y > 1.0) {
          out_FragColor = vec4(vec3(0.0), 1.0);
          return;
        }

        float pixSize = mix(1.0, pixelation, intensity);
        vec2 snappedUV = floor(distUV * dims / pixSize) * pixSize / dims;
        distUV = mix(distUV, snappedUV, intensity);

        vec4 original = texture(colorTexture, distUV);
        float luma = dot(original.rgb, vec3(0.299, 0.587, 0.114));
        float gainLevel = mix(0.8, 2.5, gain);
        float amplified = pow(clamp(luma * gainLevel, 0.0, 1.0), mix(1.2, 0.7, gain));

        float bloomAccum = 0.0;
        float bloomW = 0.0;
        for (int y = -4; y <= 4; y++) {
          for (int x = -4; x <= 4; x++) {
            vec2 offset = vec2(float(x), float(y)) * texel * 4.0;
            float sLuma = dot(texture(colorTexture, distUV + offset).rgb, vec3(0.299, 0.587, 0.114));
            float bright = smoothstep(0.4, 0.9, sLuma * gainLevel);
            float w = exp(-float(x * x + y * y) / 14.0);
            bloomAccum += bright * w;
            bloomW += w;
          }
        }
        bloomAccum /= bloomW;

        vec3 phosphor = vec3(0.16, 1.0, 0.22);
        vec3 nvgColor = phosphor * (amplified + bloomAccum * bloom * 1.5);

        float tubeGrain = (valueNoise(uv * 120.0 + vec2(time * 0.5, time * 0.3)) - 0.5) * mix(0.06, 0.2, gain) * intensity;
        nvgColor += phosphor * tubeGrain;
        float darkNoise = (1.0 - amplified) * hash(uv * dims + vec2(time * 200.0, time * 300.0));
        nvgColor += phosphor * darkNoise * 0.08 * gain * intensity;

        nvgColor *= 1.0 - honeycomb(distUV) * 0.04 * intensity;
        float scanline = pow(sin(distUV.y * dims.y * 1.2 + time * 2.0) * 0.5 + 0.5, 2.5);
        nvgColor *= 1.0 - scanline * scanlineStr * 0.15 * intensity;
        nvgColor *= tubeShading * tubeMask;
        nvgColor += phosphor * crosshair(uv) * 0.4 * intensity;

        vec3 recPos = vec3(uv - vec2(0.95, 0.94), 0.0);
        float recDot = smoothstep(0.008, 0.004, length(recPos.xy));
        float blink = step(0.5, fract(time * 0.8));
        nvgColor += vec3(0.3, 1.0, 0.2) * recDot * blink * intensity;

        nvgColor = clamp(nvgColor, 0.0, 1.0);
        out_FragColor = vec4(mix(original.rgb, nvgColor * tubeMask, intensity), 1.0);
      }
    `,
  },

  thermal: {
    id: 'thermal',
    label: 'FLIR',
    shortLabel: 'FLIR',
    hotkey: '4',
    description: 'Forward Looking Infrared with White-Hot / Black-Hot and Ironbow false-color ramp.',
    uniforms: [
      { key: 'sensitivity', label: 'Sensitivity', default: 0.85, min: 0, max: 1, step: 0.02 },
      { key: 'bloom', label: 'Bloom', default: 0.2, min: 0, max: 1, step: 0.02 },
      { key: 'mode', label: 'WHOT/BHOT', default: 0.33, min: 0, max: 1, step: 0.05 },
      { key: 'pixelation', label: 'Pixelation', default: 1.0, min: 1, max: 6, step: 0.25 },
      { key: 'palette', label: 'Ironbow', default: 0.0, min: 0, max: 1, step: 0.05 },
    ],
    fragmentShader: /* glsl */ `
      uniform sampler2D colorTexture;
      uniform vec2 colorTextureDimensions;
      uniform float intensity;
      uniform float time;
      uniform float sensitivity;
      uniform float bloom;
      uniform float mode;
      uniform float pixelation;
      uniform float palette;
      in vec2 v_textureCoordinates;

      vec3 ironbow(float t) {
        t = clamp(t, 0.0, 1.0);
        const vec3 c0 = vec3(0.0, 0.0, 0.0);
        const vec3 c1 = vec3(0.13, 0.0, 0.30);
        const vec3 c2 = vec3(0.49, 0.0, 0.45);
        const vec3 c3 = vec3(0.86, 0.10, 0.18);
        const vec3 c4 = vec3(1.0, 0.55, 0.0);
        const vec3 c5 = vec3(1.0, 0.91, 0.32);
        const vec3 c6 = vec3(1.0, 1.0, 1.0);
        float s = t * 6.0;
        if (s < 1.0) return mix(c0, c1, s);
        if (s < 2.0) return mix(c1, c2, s - 1.0);
        if (s < 3.0) return mix(c2, c3, s - 2.0);
        if (s < 4.0) return mix(c3, c4, s - 3.0);
        if (s < 5.0) return mix(c4, c5, s - 4.0);
        return mix(c5, c6, s - 5.0);
      }

      float hash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      float valueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }

      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
          v += a * valueNoise(p);
          p = p * 2.0 + vec2(100.0);
          a *= 0.5;
        }
        return v;
      }

      float crosshair(vec2 uv) {
        vec2 c = uv - 0.5;
        float h = smoothstep(0.0015, 0.0005, abs(c.y)) * step(0.015, abs(c.x)) * step(abs(c.x), 0.04);
        float v = smoothstep(0.0015, 0.0005, abs(c.x)) * step(0.015, abs(c.y)) * step(abs(c.y), 0.04);
        return clamp(h + v, 0.0, 1.0);
      }

      void main() {
        vec2 uv = v_textureCoordinates;
        vec2 dims = colorTextureDimensions;
        vec2 texel = 1.0 / dims;
        vec2 hudUV = uv;

        vec2 centered = uv * 2.0 - 1.0;
        centered.x *= dims.x / dims.y;
        float radius = length(centered);
        float lensMask = pow(1.0 - smoothstep(0.6, 1.05, radius), 0.7);
        float lensShading = max(1.0 - radius * radius * 0.25, 0.0);

        if (lensMask < 0.001) {
          out_FragColor = vec4(vec3(0.0), 1.0);
          return;
        }

        float pixSize = mix(1.0, pixelation, intensity);
        vec2 snappedUV = floor(uv * dims / pixSize) * pixSize / dims;
        uv = mix(uv, snappedUV, intensity);

        vec3 blurred = vec3(0.0);
        float totalWeight = 0.0;
        for (int y = -2; y <= 2; y++) {
          for (int x = -2; x <= 2; x++) {
            float w = exp(-0.5 * float(x * x + y * y) / 2.0);
            blurred += texture(colorTexture, uv + vec2(float(x), float(y)) * texel * 1.5).rgb * w;
            totalWeight += w;
          }
        }
        blurred /= totalWeight;
        vec4 original = texture(colorTexture, uv);
        vec3 src = mix(original.rgb, blurred, 0.6 * intensity);

        float luma = dot(src, vec3(0.299, 0.587, 0.114));
        float sens = mix(0.25, 1.0, sensitivity);
        float temp = clamp((luma - (0.5 - sens * 0.5)) / sens, 0.0, 1.0);

        float bandLine = abs(fract(temp * 12.0) - 0.5);
        float contour = smoothstep(0.04, 0.06, bandLine);
        temp *= mix(1.0, contour * 0.85 + 0.15, 0.3 * intensity);

        float isBlackHot = step(0.5, mode);
        float thermal = mix(temp, 1.0 - temp, isBlackHot);
        vec3 thermalColor = mix(vec3(thermal), ironbow(temp), palette);

        float bloomSample = 0.0;
        float bloomWeight = 0.0;
        for (int y = -3; y <= 3; y++) {
          for (int x = -3; x <= 3; x++) {
            vec2 offset = vec2(float(x), float(y)) * texel * 3.0;
            float sLuma = dot(texture(colorTexture, uv + offset).rgb, vec3(0.299, 0.587, 0.114));
            float sMapped = clamp((sLuma - (0.5 - sens * 0.5)) / sens, 0.0, 1.0);
            float sFinal = mix(sMapped, 1.0 - sMapped, isBlackHot);
            float w = exp(-0.5 * float(x * x + y * y) / 6.0);
            bloomSample += smoothstep(0.6, 1.0, sFinal) * w;
            bloomWeight += w;
          }
        }
        thermalColor += (bloomSample / bloomWeight) * bloom * 0.8;
        thermalColor += (fbm(uv * 80.0 + vec2(time * 0.3, time * 0.2)) - 0.5) * 0.08 * intensity;

        float bar = step(0.94, hudUV.x) * step(hudUV.x, 0.955) * step(0.15, hudUV.y) * step(hudUV.y, 0.85);
        if (bar > 0.0) {
          float barGrad = (hudUV.y - 0.15) / 0.7;
          float barVal = mix(barGrad, 1.0 - barGrad, isBlackHot);
          thermalColor = mix(thermalColor, palette > 0.5 ? ironbow(barGrad) : vec3(barVal), bar * 0.9);
        }

        thermalColor += crosshair(hudUV) * 0.45 * intensity;
        thermalColor = clamp(thermalColor * lensShading * lensMask, 0.0, 1.0);

        vec3 finalColor = mix(original.rgb, thermalColor, intensity) * mix(1.0, lensMask, intensity);
        out_FragColor = vec4(finalColor, 1.0);
      }
    `,
  },

  anime: {
    id: 'anime',
    label: 'Anime',
    shortLabel: 'Anime',
    hotkey: '5',
    description: 'Vibrant cel-shaded palette with ink-style Sobel edge outlines.',
    uniforms: [
      { key: 'saturation', label: 'Saturation', default: 1.0, min: 0, max: 2, step: 0.05 },
      { key: 'edgeThick', label: 'Edge Thickness', default: 0.5, min: 0, max: 1, step: 0.05 },
    ],
    fragmentShader: /* glsl */ `
      uniform sampler2D colorTexture;
      uniform vec2 colorTextureDimensions;
      uniform float intensity;
      uniform float saturation;
      uniform float edgeThick;
      in vec2 v_textureCoordinates;

      vec3 rgb2hsv(vec3 c) {
        vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
        vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
        vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
        float d = q.x - min(q.w, q.y);
        float e = 1.0e-10;
        return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
      }

      vec3 hsv2rgb(vec3 c) {
        vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
        vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
        return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
      }

      void main() {
        vec2 uv = v_textureCoordinates;
        vec2 texel = 1.0 / colorTextureDimensions;
        vec4 color = texture(colorTexture, uv);

        float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
        float bands = mix(256.0, 4.0, intensity);
        float celLuma = floor(luma * bands + 0.5) / bands;
        vec3 celColor = color.rgb * ((luma > 0.001) ? celLuma / luma : 1.0);

        vec3 hsv = rgb2hsv(celColor);
        hsv.y = min(hsv.y * (1.0 + 0.6 * intensity * saturation), 1.0);
        hsv.z = min(hsv.z * (1.0 + 0.1 * intensity), 1.0);
        vec3 saturated = hsv2rgb(hsv);

        vec4 left  = texture(colorTexture, uv + vec2(-texel.x, 0.0));
        vec4 right = texture(colorTexture, uv + vec2( texel.x, 0.0));
        vec4 up    = texture(colorTexture, uv + vec2(0.0,  texel.y));
        vec4 down  = texture(colorTexture, uv + vec2(0.0, -texel.y));

        float edge = sqrt(pow(length(right.rgb - left.rgb), 2.0) + pow(length(up.rgb - down.rgb), 2.0));
        float outline = 1.0 - smoothstep(0.05, mix(0.35, 0.1, edgeThick), edge) * 0.6 * intensity;

        vec3 result = saturated * vec3(1.02, 1.0, 0.95) * outline;
        out_FragColor = vec4(mix(color.rgb, result, intensity), color.a);
      }
    `,
  },

  noir: {
    id: 'noir',
    label: 'Noir',
    shortLabel: 'Noir',
    hotkey: '6',
    description: 'High-contrast monochrome film-noir grading with grain and vignette.',
    uniforms: [
      { key: 'contrastAmt', label: 'Contrast', default: 1.2, min: 0, max: 2, step: 0.05 },
      { key: 'grainAmt', label: 'Grain', default: 0.5, min: 0, max: 1, step: 0.05 },
      { key: 'vignetteAmt', label: 'Vignette', default: 0.5, min: 0, max: 1, step: 0.05 },
    ],
    fragmentShader: /* glsl */ `
      uniform sampler2D colorTexture;
      uniform vec2 colorTextureDimensions;
      uniform float intensity;
      uniform float contrastAmt;
      uniform float grainAmt;
      uniform float vignetteAmt;
      in vec2 v_textureCoordinates;

      void main() {
        vec2 uv = v_textureCoordinates;
        vec4 color = texture(colorTexture, uv);

        float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
        vec3 desaturated = mix(color.rgb, vec3(luma), intensity);
        vec3 contrasted = clamp((desaturated - 0.5) * (1.0 + contrastAmt * intensity) + 0.5, 0.0, 1.0);

        float grain = fract(sin(dot(uv * colorTextureDimensions, vec2(12.9898, 78.233))) * 43758.5453);
        contrasted += (grain - 0.5) * 0.08 * grainAmt * intensity;

        vec2 vigUV = uv * (1.0 - uv);
        float vig = pow(vigUV.x * vigUV.y * 16.0, 0.3 + 0.4 * vignetteAmt * intensity);

        vec3 sepia = vec3(
          dot(contrasted, vec3(0.393, 0.769, 0.189)),
          dot(contrasted, vec3(0.349, 0.686, 0.168)),
          dot(contrasted, vec3(0.272, 0.534, 0.131))
        );
        vec3 result = mix(contrasted, sepia, 0.15 * intensity) * vig;
        out_FragColor = vec4(mix(color.rgb, result, intensity), color.a);
      }
    `,
  },
};

export const STYLE_BUTTONS: Array<{
  id: VisualStyleId;
  label: string;
  hotkey: string;
  glyph: string;
}> = [
  { id: 'normal', label: 'Normal', hotkey: '1', glyph: '◯' },
  { id: 'retro', label: 'CRT', hotkey: '2', glyph: '▦' },
  { id: 'surveillance', label: 'NVG', hotkey: '3', glyph: '☾' },
  { id: 'thermal', label: 'FLIR', hotkey: '4', glyph: '◈' },
  { id: 'anime', label: 'Anime', hotkey: '5', glyph: '✦' },
  { id: 'noir', label: 'Noir', hotkey: '6', glyph: '◐' },
];
