// Turns a SAM mask outline into compact shapes the board can draw.
// SAM's parser traces every pixel edge, so a single part can have thousands of points.
// We move it into picture coordinates, drop specks, and simplify each contour.

// `mask` comes from meta.segment: { path, bounds, rasterWidth, rasterHeight }.
// Returns { contours: [[[x, y], ...], ...], box: [l, t, r, b], center: [x, y], area } or null.
function maskToShape(mask, { tolerance = 2 } = {}) {
  const { left, top, right, bottom } = mask.bounds;
  const sx = (right - left) / mask.rasterWidth;
  const sy = (bottom - top) / mask.rasterHeight;

  const rings = parsePath(mask.path)
    .map((ring) => ring.map(([x, y]) => [left + (x + 0.5) * sx, top + (y + 0.5) * sy]))
    .map((ring) => ({ ring, area: polygonArea(ring) }))
    .filter((r) => r.ring.length >= 3);
  if (!rings.length) return null;

  // Keep the main region and any piece at least 4% of its size; skip specks and noise.
  const biggest = Math.max(...rings.map((r) => Math.abs(r.area)));
  const kept = rings
    .filter((r) => Math.abs(r.area) >= Math.max(biggest * 0.04, 250))
    .sort((a, b) => Math.abs(b.area) - Math.abs(a.area))
    .slice(0, 8);

  const contours = kept.map((r) => simplifyClosed(r.ring, tolerance).map(([x, y]) => [round1(x), round1(y)]));
  const main = kept[0].ring;
  const xs = main.map((p) => p[0]);
  const ys = main.map((p) => p[1]);
  return {
    contours,
    box: [Math.floor(Math.min(...xs)), Math.floor(Math.min(...ys)), Math.ceil(Math.max(...xs)), Math.ceil(Math.max(...ys))],
    center: interiorPoint(main),
    area: Math.round(Math.abs(kept[0].area)),
  };
}

// "M x y L x y ... Z M ..." into rings of [x, y].
function parsePath(d) {
  const rings = [];
  let ring = null;
  for (const m of d.matchAll(/([MLZ])\s*(-?[\d.]+)?[\s,]*(-?[\d.]+)?/gi)) {
    const cmd = m[1].toUpperCase();
    if (cmd === "M") { ring = [[+m[2], +m[3]]]; rings.push(ring); }
    else if (cmd === "L" && ring) ring.push([+m[2], +m[3]]);
    else if (cmd === "Z") ring = null;
  }
  return rings;
}

function polygonArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return a / 2;
}

// Ramer-Douglas-Peucker on a closed ring: split at the two farthest-apart points, simplify each half.
function simplifyClosed(ring, tol) {
  if (ring.length < 8) return ring;
  let far = 0, farD = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2;
    if (d > farD) { farD = d; far = i; }
  }
  const a = rdp(ring.slice(0, far + 1), tol);
  const b = rdp(ring.slice(far).concat([ring[0]]), tol);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

function rdp(pts, tol) {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let idx = -1, max = tol;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(pts[i], pts[s], pts[e]);
      if (d > max) { max = d; idx = i; }
    }
    if (idx !== -1) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// A point well inside the shape (not just the bounding-box middle, which can fall
// outside a crescent or a winding lava flow): the midpoint of the widest horizontal
// run through the shape, scanned across its height.
function interiorPoint(ring) {
  const ys = ring.map((p) => p[1]);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  let best = null;
  for (let k = 1; k < 20; k++) {
    const y = minY + ((maxY - minY) * k) / 20;
    const xs = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j], [x2, y2] = ring[i];
      if ((y1 > y) !== (y2 > y)) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = xs[i + 1] - xs[i];
      if (!best || w > best.w) best = { w, x: (xs[i] + xs[i + 1]) / 2, y };
    }
  }
  return best ? [round1(best.x), round1(best.y)] : [round1((Math.min(...ring.map((p) => p[0])) + Math.max(...ring.map((p) => p[0]))) / 2), round1((minY + maxY) / 2)];
}

const round1 = (v) => Math.round(v * 10) / 10;

module.exports = { maskToShape };
