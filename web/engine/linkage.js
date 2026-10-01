// The parts of SciPy 1.18.1 the speaker grouping uses, ported line for line so
// merge order, tie-breaking and every float64 rounding match:
//
//   pdistEuclidean   scipy.spatial.distance.pdist(X, "euclidean")
//   linkageCentroid  scipy.cluster.hierarchy.linkage(X, "centroid", "euclidean")
//                    = pdist + _hierarchy.fast_linkage (Müllner's generic
//                    algorithm with a binary heap of nearest-neighbour bounds)
//   fcluster         fcluster(Z, t, criterion="distance")
//                    = get_max_dist_for_each_cluster + cluster_monocrit
//   cdistCosine      scipy.spatial.distance.cdist(A, B, "cosine")
//
// Sources: scipy/cluster/hierarchy/_hierarchy.pyx, _structures.pxi,
// _hierarchy_distance_update.pxi; scipy/spatial/src/distance_metrics.h,
// distance_impl.h (tag v1.18.1).

/** Condensed index of (i, j), i != j, in an n x n condensed matrix. */
function condensed(n, i, j) {
  if (i < j) return n * i - (i * (i + 1)) / 2 + (j - i - 1);
  return n * j - (j * (j + 1)) / 2 + (i - j - 1);
}

/** pdist(X, "euclidean") for X (n rows of d, row-major, any numeric array). */
export function pdistEuclidean(X, n, d) {
  const out = new Float64Array((n * (n - 1)) / 2);
  let at = 0;
  for (let i = 0; i < n; i++) {
    const oi = i * d;
    for (let j = i + 1; j < n; j++) {
      const oj = j * d;
      let s = 0;
      for (let k = 0; k < d; k++) {
        const diff = Math.abs(X[oi + k] - X[oj + k]);
        s += diff * diff;
      }
      out[at++] = Math.sqrt(s);
    }
  }
  return out;
}

// Binary heap of values keyed 0..n-1 (_structures.pxi Heap).
class Heap {
  constructor(values) {
    this.size = values.length;
    this.indexByKey = new Int32Array(this.size);
    this.keyByIndex = new Int32Array(this.size);
    for (let i = 0; i < this.size; i++) { this.indexByKey[i] = i; this.keyByIndex[i] = i; }
    this.values = Float64Array.from(values);
    for (let i = Math.trunc(this.size / 2) - 1; i >= 0; i--) this.siftDown(i);
  }
  minKey() { return this.keyByIndex[0]; }
  minValue() { return this.values[0]; }
  removeMin() { this.swap(0, this.size - 1); this.size -= 1; this.siftDown(0); }
  changeValue(key, value) {
    const index = this.indexByKey[key];
    const old = this.values[index];
    this.values[index] = value;
    if (value < old) this.siftUp(index); else this.siftDown(index);
  }
  siftUp(index) {
    let parent = (index - 1) >> 1;
    while (index > 0 && this.values[parent] > this.values[index]) {
      this.swap(index, parent);
      index = parent;
      parent = (index - 1) >> 1;
    }
  }
  siftDown(index) {
    let child = (index << 1) + 1;
    while (child < this.size) {
      if (child + 1 < this.size && this.values[child + 1] < this.values[child]) child += 1;
      if (this.values[index] > this.values[child]) {
        this.swap(index, child);
        index = child;
        child = (index << 1) + 1;
      } else break;
    }
  }
  swap(i, j) {
    const v = this.values[i]; this.values[i] = this.values[j]; this.values[j] = v;
    const ki = this.keyByIndex[i], kj = this.keyByIndex[j];
    this.keyByIndex[i] = kj; this.keyByIndex[j] = ki;
    this.indexByKey[ki] = j; this.indexByKey[kj] = i;
  }
}

// _centroid in _hierarchy_distance_update.pxi (C evaluation order kept).
function centroidUpdate(dxi, dyi, dxy, sx, sy) {
  return Math.sqrt((((sx * dxi * dxi) + (sy * dyi * dyi)) - (sx * sy * dxy * dxy) / (sx + sy)) / (sx + sy));
}

function findMinDist(n, D, size, x) {
  let current = Infinity, y = -1;
  for (let i = x + 1; i < n; i++) {
    if (size[i] === 0) continue;
    const dist = D[condensed(n, x, i)];
    if (dist < current) { current = dist; y = i; }
  }
  if (y === -1) throw new Error('find_min_dist cannot find any neighbors closer than inf away');
  return [y, current];
}

/**
 * fast_linkage(dists, n, centroid): the linkage matrix as a Float64Array of
 * (n - 1) rows [id_a, id_b, distance, size].
 */
export function fastLinkage(dists, n) {
  const Z = new Float64Array((n - 1) * 4);
  const D = Float64Array.from(dists);
  const size = new Int32Array(n).fill(1);
  const clusterId = new Int32Array(n);
  for (let i = 0; i < n; i++) clusterId[i] = i;
  const neighbor = new Int32Array(n - 1);
  const minDist = new Float64Array(n - 1);
  for (let x = 0; x < n - 1; x++) {
    const [y, d] = findMinDist(n, D, size, x);
    neighbor[x] = y; minDist[x] = d;
  }
  const heap = new Heap(minDist);
  let x = 0, y = 0, dist = 0;
  for (let k = 0; k < n - 1; k++) {
    for (let i = 0; i < n - k; i++) {
      x = heap.minKey(); dist = heap.minValue();
      y = neighbor[x];
      if (dist === D[condensed(n, x, y)]) break;
      [y, dist] = findMinDist(n, D, size, x);
      neighbor[x] = y; minDist[x] = dist;
      heap.changeValue(x, dist);
    }
    heap.removeMin();
    let idX = clusterId[x], idY = clusterId[y];
    const nx = size[x], ny = size[y];
    if (idX > idY) { const t = idX; idX = idY; idY = t; }
    Z[4 * k] = idX; Z[4 * k + 1] = idY; Z[4 * k + 2] = dist; Z[4 * k + 3] = nx + ny;
    size[x] = 0;
    size[y] = nx + ny;
    clusterId[y] = n + k;
    for (let z = 0; z < n; z++) {
      const nz = size[z];
      if (nz === 0 || z === y) continue;
      D[condensed(n, z, y)] = centroidUpdate(D[condensed(n, z, x)], D[condensed(n, z, y)], dist, nx, ny);
    }
    for (let z = 0; z < x; z++) if (size[z] > 0 && neighbor[z] === x) neighbor[z] = y;
    for (let z = 0; z < y; z++) {
      if (size[z] === 0) continue;
      const d = D[condensed(n, z, y)];
      if (d < minDist[z]) { neighbor[z] = y; minDist[z] = d; heap.changeValue(z, d); }
    }
    if (y < n - 1) {
      const [z, d] = findMinDist(n, D, size, y);
      if (z !== -1) { neighbor[y] = z; minDist[y] = d; heap.changeValue(y, d); }
    }
  }
  return Z;
}

/** linkage(X, method="centroid", metric="euclidean") for n rows of d values. */
export function linkageCentroid(X, n, d) {
  const dists = pdistEuclidean(X, n, d);
  for (const v of dists) if (!Number.isFinite(v)) throw new Error('The condensed distance matrix must contain only finite values.');
  return fastLinkage(dists, n);
}

/** fcluster(Z, t, criterion="distance"): flat cluster numbers from 1 (Int32Array). */
export function fcluster(Z, n, t) {
  // get_max_dist_for_each_cluster
  const MD = new Float64Array(n);
  const visited = new Uint8Array(2 * n);
  const curr = new Int32Array(n);
  let k = 0;
  curr[0] = 2 * n - 2;
  while (k >= 0) {
    const root = curr[k] - n;
    const lc = Z[4 * root] | 0, rc = Z[4 * root + 1] | 0;
    if (lc >= n && !visited[lc]) { visited[lc] = 1; curr[++k] = lc; continue; }
    if (rc >= n && !visited[rc]) { visited[rc] = 1; curr[++k] = rc; continue; }
    let m = Z[4 * root + 2];
    if (lc >= n && MD[lc - n] > m) m = MD[lc - n];
    if (rc >= n && MD[rc - n] > m) m = MD[rc - n];
    MD[root] = m;
    k -= 1;
  }
  // cluster_monocrit
  const T = new Int32Array(n);
  visited.fill(0);
  let nCluster = 0, leader = -1;
  k = 0;
  curr[0] = 2 * n - 2;
  while (k >= 0) {
    const root = curr[k] - n;
    const lc = Z[4 * root] | 0, rc = Z[4 * root + 1] | 0;
    if (leader === -1 && MD[root] <= t) { leader = root; nCluster += 1; }
    if (lc >= n && !visited[lc]) { visited[lc] = 1; curr[++k] = lc; continue; }
    if (rc >= n && !visited[rc]) { visited[rc] = 1; curr[++k] = rc; continue; }
    if (lc < n) { if (leader === -1) nCluster += 1; T[lc] = nCluster; }
    if (rc < n) { if (leader === -1) nCluster += 1; T[rc] = nCluster; }
    if (leader === root) leader = -1;
    k -= 1;
  }
  return T;
}

/**
 * cdist(A, B, "cosine") for na and nb rows of d values: Float64Array (na, nb).
 * Zero rows give NaN, as SciPy's C loop does (0 / 0).
 */
export function cdistCosine(A, na, B, nb, d) {
  const norms = (X, m) => {
    const out = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let j = 0; j < d; j++) { const v = X[i * d + j]; s += v * v; }
      out[i] = Math.sqrt(s);
    }
    return out;
  };
  const nA = norms(A, na), nB = norms(B, nb);
  const out = new Float64Array(na * nb);
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < nb; j++) {
      let s = 0;
      for (let k = 0; k < d; k++) s += A[i * d + k] * B[j * d + k];
      let c = s / (nA[i] * nB[j]);
      if (Math.abs(c) > 1) c = Math.sign(c);
      out[i * nb + j] = 1 - c;
    }
  }
  return out;
}
