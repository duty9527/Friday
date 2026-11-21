#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define TILE_W 32u
#define TILE_H 16u
#define TILE_ROW_BYTES (TILE_W * 2u)
#define TILE_MSG_BYTES (4u + TILE_W * TILE_H * 2u)

/**
 * Convert Cairo FORMAT_ARGB32 pixels (byte order B, G, R, A on little-endian)
 * into CS80 BGR565 little-endian pixels.
 */
void bgra_to_bgr565(const uint8_t *bgra, uint16_t *out, size_t pixels) {
  if (!bgra || !out) return;
  for (size_t i = 0; i < pixels; i++) {
    uint32_t b = bgra[i * 4u + 0u];
    uint32_t g = bgra[i * 4u + 1u];
    uint32_t r = bgra[i * 4u + 2u];
    out[i] = (uint16_t)(((b & 0xF8u) << 8) | ((g & 0xFCu) << 3) | (r >> 3));
  }
}

/**
 * Convert CS80 BGR565 little-endian pixels back into tightly packed RGB24.
 */
void bgr565_to_rgb24(const uint16_t *in565, uint8_t *rgb, size_t pixels) {
  if (!in565 || !rgb) return;
  for (size_t i = 0; i < pixels; i++) {
    uint16_t px = in565[i];
    uint8_t b5 = (uint8_t)((px >> 11) & 0x1Fu);
    uint8_t g6 = (uint8_t)((px >> 5) & 0x3Fu);
    uint8_t r5 = (uint8_t)(px & 0x1Fu);
    rgb[i * 3u + 0u] = (uint8_t)((r5 << 3) | (r5 >> 2));
    rgb[i * 3u + 1u] = (uint8_t)((g6 << 2) | (g6 >> 4));
    rgb[i * 3u + 2u] = (uint8_t)((b5 << 3) | (b5 >> 2));
  }
}

/**
 * Diff two BGR565 framebuffers on 32x16 tile boundaries.
 * Writes up to `max_tiles` records of (u16 x, u16 y, 1024 B BGR565) into `out_tiles`.
 * If more than `max_tiles` tiles differ, returns `max_tiles + 1` early so the caller
 * can fall back to pushing a full frame.
 */
uint32_t diff_tiles_32x16(
    const uint16_t *prev,
    const uint16_t *curr,
    uint32_t width,
    uint32_t height,
    uint8_t *out_tiles,
    uint32_t max_tiles) {
  if (!prev || !curr || width < TILE_W || height < TILE_H) return 0;
  if (max_tiles > 0 && !out_tiles) return max_tiles + 1u;
  uint32_t dirty = 0;
  for (uint32_t ty = 0; ty + TILE_H <= height; ty += TILE_H) {
    for (uint32_t tx = 0; tx + TILE_W <= width; tx += TILE_W) {
      int changed = 0;
      for (uint32_t row = 0; row < TILE_H; row++) {
        size_t off = (size_t)(ty + row) * width + tx;
        if (memcmp(prev + off, curr + off, TILE_ROW_BYTES) != 0) {
          changed = 1;
          break;
        }
      }
      if (!changed) continue;
      if (dirty >= max_tiles) {
        return max_tiles + 1u;
      }
      uint8_t *dst = out_tiles + (size_t)dirty * TILE_MSG_BYTES;
      dst[0] = (uint8_t)(tx & 0xFFu);
      dst[1] = (uint8_t)((tx >> 8) & 0xFFu);
      dst[2] = (uint8_t)(ty & 0xFFu);
      dst[3] = (uint8_t)((ty >> 8) & 0xFFu);
      uint8_t *px_dst = dst + 4u;
      for (uint32_t row = 0; row < TILE_H; row++) {
        size_t off = (size_t)(ty + row) * width + tx;
        memcpy(px_dst + (size_t)row * TILE_ROW_BYTES, curr + off, TILE_ROW_BYTES);
      }
      dirty++;
    }
  }
  return dirty;
}
