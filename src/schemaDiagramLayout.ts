/**
 * Pure, deterministic layout algorithm for schema diagram table positioning.
 * No DOM access, no side effects, no browser APIs.
 * Computes {x, y} positions using force-directed simulation.
 */

export interface LayoutInput {
  tables: Array<{ schema: string; name: string }>;
  relationships: Array<{
    fromSchema: string; fromTable: string;
    toSchema: string; toTable: string;
  }>;
  config?: Partial<LayoutConfig>;
}

export interface LayoutConfig {
  canvasWidth: number;    // default: 1920
  canvasHeight: number;   // default: 1080
  cardWidth: number;      // fixed: 220
  cardHeight: number;     // fixed: 60 (collapsed)
  minGap: number;         // minimum 24px between cards
  iterations: number;     // fixed iteration count for determinism
}

export interface Position { x: number; y: number; }

export type PositionMap = Map<string, Position>;

const DEFAULT_CONFIG: LayoutConfig = {
  canvasWidth: 1920,
  canvasHeight: 1080,
  cardWidth: 220,
  cardHeight: 60,
  minGap: 24,
  iterations: 300,
};

// Force simulation parameters
const REPULSION_STRENGTH = 8000;
const ATTRACTION_STRENGTH = 0.003;
const GRAVITY_STRENGTH = 0.005;
const DAMPING_FACTOR = 0.85;
const ISOLATED_TABLE_OFFSET = 80;

/**
 * Computes layout positions for all tables using a force-directed simulation.
 * 
 * Algorithm:
 * 1. Build adjacency map from relationships
 * 2. Initialize positions: circular layout for connected, grid for isolated
 * 3. Run N iterations of force simulation (repulsion, attraction, gravity, damping)
 * 4. Overlap resolution pass
 * 5. Clamp positions within bounds
 * 6. Enforce isolated table separation from connected cluster
 * 
 * Determinism: Fixed iteration count, no random initialization, positions derived from input order.
 */
export function layoutAlgorithm(input: LayoutInput): PositionMap {
  const config: LayoutConfig = { ...DEFAULT_CONFIG, ...input.config };
  const result: PositionMap = new Map();

  // Handle empty input
  if (!input.tables || input.tables.length === 0) {
    return result;
  }

  // Deduplicate tables: use first occurrence only
  const seen = new Set<string>();
  const uniqueTables: Array<{ schema: string; name: string; key: string }> = [];
  for (const table of input.tables) {
    const key = `${table.schema}.${table.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueTables.push({ schema: table.schema, name: table.name, key });
    }
  }

  // Single table: position near center
  if (uniqueTables.length === 1) {
    const centerX = config.canvasWidth / 2 - config.cardWidth / 2;
    const centerY = config.canvasHeight / 2 - config.cardHeight / 2;
    result.set(uniqueTables[0].key, { x: centerX, y: centerY });
    return result;
  }

  // Build adjacency map from relationships
  const adjacency = buildAdjacencyMap(uniqueTables, input.relationships);

  // Classify tables as connected or isolated
  const connectedKeys = new Set<string>();
  for (const [key, neighbors] of adjacency.entries()) {
    if (neighbors.size > 0) {
      connectedKeys.add(key);
    }
  }
  const isolatedKeys = uniqueTables
    .map(t => t.key)
    .filter(k => !connectedKeys.has(k));

  // Initialize positions
  const positions = initializePositions(uniqueTables, connectedKeys, isolatedKeys, config);

  // Velocity vectors for force simulation
  const velocities = new Map<string, { vx: number; vy: number }>();
  for (const t of uniqueTables) {
    velocities.set(t.key, { vx: 0, vy: 0 });
  }

  // Force simulation loop
  const centerX = config.canvasWidth / 2;
  const centerY = config.canvasHeight / 2;
  const keys = uniqueTables.map(t => t.key);

  for (let iter = 0; iter < config.iterations; iter++) {
    // Reset forces
    const forces = new Map<string, { fx: number; fy: number }>();
    for (const key of keys) {
      forces.set(key, { fx: 0, fy: 0 });
    }

    // Repulsion force: all pairs push apart (inverse-square)
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const keyA = keys[i];
        const keyB = keys[j];
        const posA = positions.get(keyA)!;
        const posB = positions.get(keyB)!;

        let dx = posA.x - posB.x;
        let dy = posA.y - posB.y;
        let distSq = dx * dx + dy * dy;

        // Prevent division by zero
        if (distSq < 1) {
          distSq = 1;
          dx = 1;
          dy = 0;
        }

        const dist = Math.sqrt(distSq);
        const force = REPULSION_STRENGTH / distSq;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        const forceA = forces.get(keyA)!;
        const forceB = forces.get(keyB)!;
        forceA.fx += fx;
        forceA.fy += fy;
        forceB.fx -= fx;
        forceB.fy -= fy;
      }
    }

    // Attraction force: connected pairs pull together (spring)
    for (const [key, neighbors] of adjacency.entries()) {
      const posA = positions.get(key)!;
      const forceA = forces.get(key)!;
      for (const neighborKey of neighbors) {
        const posB = positions.get(neighborKey)!;
        const dx = posB.x - posA.x;
        const dy = posB.y - posA.y;
        const fx = dx * ATTRACTION_STRENGTH;
        const fy = dy * ATTRACTION_STRENGTH;
        forceA.fx += fx;
        forceA.fy += fy;
      }
    }

    // Gravity toward center
    for (const key of keys) {
      const pos = positions.get(key)!;
      const f = forces.get(key)!;
      const dx = centerX - pos.x;
      const dy = centerY - pos.y;
      f.fx += dx * GRAVITY_STRENGTH;
      f.fy += dy * GRAVITY_STRENGTH;
    }

    // Apply forces to velocities with damping, then update positions
    for (const key of keys) {
      const vel = velocities.get(key)!;
      const f = forces.get(key)!;
      vel.vx = (vel.vx + f.fx) * DAMPING_FACTOR;
      vel.vy = (vel.vy + f.fy) * DAMPING_FACTOR;
      const pos = positions.get(key)!;
      pos.x += vel.vx;
      pos.y += vel.vy;
    }
  }

  // Overlap resolution pass
  resolveOverlaps(keys, positions, config);

  // Enforce isolated table separation from connected cluster convex hull
  if (connectedKeys.size > 0 && isolatedKeys.length > 0) {
    enforceIsolatedSeparation(connectedKeys, isolatedKeys, positions, config);
  }

  // Final overlap resolution after isolation enforcement
  resolveOverlaps(keys, positions, config);

  // Normalize positions: shift so the top-left of the bounding box is at (padding, padding)
  // This ensures the diagram starts in the visible viewport area rather than being offset
  const LAYOUT_PADDING = 40;
  let minPosX = Infinity, minPosY = Infinity;
  for (const key of keys) {
    const pos = positions.get(key)!;
    if (pos.x < minPosX) { minPosX = pos.x; }
    if (pos.y < minPosY) { minPosY = pos.y; }
  }
  if (minPosX !== Infinity) {
    const shiftX = LAYOUT_PADDING - minPosX;
    const shiftY = LAYOUT_PADDING - minPosY;
    for (const key of keys) {
      const pos = positions.get(key)!;
      pos.x += shiftX;
      pos.y += shiftY;
    }
  }

  // Build result map
  for (const key of keys) {
    const pos = positions.get(key)!;
    result.set(key, { x: pos.x, y: pos.y });
  }

  return result;
}

/**
 * Builds an adjacency map from relationships.
 * Only includes relationships where both ends exist in the table set.
 */
function buildAdjacencyMap(
  tables: Array<{ key: string }>,
  relationships: LayoutInput['relationships']
): Map<string, Set<string>> {
  const tableKeys = new Set(tables.map(t => t.key));
  const adjacency = new Map<string, Set<string>>();

  for (const t of tables) {
    adjacency.set(t.key, new Set());
  }

  for (const rel of relationships) {
    const fromKey = `${rel.fromSchema}.${rel.fromTable}`;
    const toKey = `${rel.toSchema}.${rel.toTable}`;

    if (tableKeys.has(fromKey) && tableKeys.has(toKey) && fromKey !== toKey) {
      adjacency.get(fromKey)!.add(toKey);
      adjacency.get(toKey)!.add(fromKey);
    }
  }

  return adjacency;
}

/**
 * Initialize positions: spread horizontally for connected tables, grid for isolated tables.
 * Uses a wider horizontal spread to avoid the spiral/diagonal pattern.
 */
function initializePositions(
  tables: Array<{ key: string }>,
  connectedKeys: Set<string>,
  isolatedKeys: string[],
  config: LayoutConfig
): Map<string, Position> {
  const positions = new Map<string, Position>();
  const centerX = config.canvasWidth / 2;
  const centerY = config.canvasHeight / 2;

  // Connected tables: horizontal row layout centered in canvas
  // This gives the force simulation a good starting point that spreads horizontally
  const connectedList = tables.filter(t => connectedKeys.has(t.key));
  if (connectedList.length > 0) {
    const spacing = config.cardWidth + config.minGap + 40; // 284px between card starts
    const totalWidth = (connectedList.length - 1) * spacing;
    const startX = centerX - totalWidth / 2;

    // Place in rows if too many for one row
    const maxPerRow = Math.max(3, Math.ceil(Math.sqrt(connectedList.length * 2)));
    const rowSpacing = config.cardHeight + config.minGap + 60;

    for (let i = 0; i < connectedList.length; i++) {
      const col = i % maxPerRow;
      const row = Math.floor(i / maxPerRow);
      const rowCount = Math.min(maxPerRow, connectedList.length - row * maxPerRow);
      const rowWidth = (rowCount - 1) * spacing;
      const rowStartX = centerX - rowWidth / 2;

      const x = rowStartX + col * spacing;
      const y = centerY - ((Math.ceil(connectedList.length / maxPerRow) - 1) * rowSpacing) / 2 + row * rowSpacing;
      positions.set(connectedList[i].key, { x, y });
    }
  }

  // Isolated tables: grid layout below connected cluster
  if (isolatedKeys.length > 0) {
    const cols = Math.ceil(Math.sqrt(isolatedKeys.length));
    const gridStartX = centerX - (cols * (config.cardWidth + config.minGap)) / 2;
    const gridStartY = centerY + config.canvasHeight * 0.25;

    for (let i = 0; i < isolatedKeys.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = gridStartX + col * (config.cardWidth + config.minGap);
      const y = gridStartY + row * (config.cardHeight + config.minGap);
      positions.set(isolatedKeys[i], { x, y });
    }
  }

  return positions;
}

/**
 * Resolve overlapping bounding boxes by pushing them apart.
 * Enforces minimum gap of minGap px between card edges.
 */
function resolveOverlaps(
  keys: string[],
  positions: Map<string, Position>,
  config: LayoutConfig
): void {
  const maxPasses = 50;
  const effectiveWidth = config.cardWidth + config.minGap;
  const effectiveHeight = config.cardHeight + config.minGap;

  for (let pass = 0; pass < maxPasses; pass++) {
    let hadOverlap = false;

    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const posA = positions.get(keys[i])!;
        const posB = positions.get(keys[j])!;

        // Check bounding box overlap including min gap
        const overlapX = effectiveWidth - Math.abs(posA.x - posB.x);
        const overlapY = effectiveHeight - Math.abs(posA.y - posB.y);

        if (overlapX > 0 && overlapY > 0) {
          hadOverlap = true;

          // Push apart along axis of minimum overlap
          if (overlapX < overlapY) {
            const pushX = overlapX / 2 + 1;
            if (posA.x < posB.x) {
              posA.x -= pushX;
              posB.x += pushX;
            } else {
              posA.x += pushX;
              posB.x -= pushX;
            }
          } else {
            const pushY = overlapY / 2 + 1;
            if (posA.y < posB.y) {
              posA.y -= pushY;
              posB.y += pushY;
            } else {
              posA.y += pushY;
              posB.y -= pushY;
            }
          }
        }
      }
    }

    if (!hadOverlap) { break; }
  }
}

/**
 * Enforce isolated tables are at least ISOLATED_TABLE_OFFSET px from connected cluster convex hull.
 */
function enforceIsolatedSeparation(
  connectedKeys: Set<string>,
  isolatedKeys: string[],
  positions: Map<string, Position>,
  config: LayoutConfig
): void {
  // Compute connected cluster bounding box (approximation of convex hull for separation)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const key of connectedKeys) {
    const pos = positions.get(key)!;
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + config.cardWidth);
    maxY = Math.max(maxY, pos.y + config.cardHeight);
  }

  // For each isolated table, ensure its bounding box edge is at least ISOLATED_TABLE_OFFSET
  // from the connected cluster bounding box
  for (const key of isolatedKeys) {
    const pos = positions.get(key)!;
    const iLeft = pos.x;
    const iRight = pos.x + config.cardWidth;
    const iTop = pos.y;
    const iBottom = pos.y + config.cardHeight;

    // Compute distance from isolated table bounding box edge to connected cluster edge
    const distLeft = iLeft - maxX;   // positive = isolated is right of cluster
    const distRight = minX - iRight; // positive = isolated is left of cluster
    const distTop = iTop - maxY;     // positive = isolated is below cluster
    const distBottom = minY - iBottom; // positive = isolated is above cluster

    // Check horizontal and vertical separation
    const hOverlap = !(distLeft >= 0 || distRight >= 0);
    const vOverlap = !(distTop >= 0 || distBottom >= 0);

    if (hOverlap && vOverlap) {
      // Inside or overlapping the cluster bounding box - push to nearest edge + offset
      const pushDistances = [
        { axis: 'x', dir: 1, dist: maxX - iLeft + ISOLATED_TABLE_OFFSET },  // push right
        { axis: 'x', dir: -1, dist: iRight - minX + ISOLATED_TABLE_OFFSET }, // push left
        { axis: 'y', dir: 1, dist: maxY - iTop + ISOLATED_TABLE_OFFSET },   // push down
        { axis: 'y', dir: -1, dist: iBottom - minY + ISOLATED_TABLE_OFFSET }, // push up
      ];
      pushDistances.sort((a, b) => a.dist - b.dist);
      const best = pushDistances[0];
      if (best.axis === 'x') {
        pos.x += best.dir * best.dist;
      } else {
        pos.y += best.dir * best.dist;
      }
    } else if (hOverlap) {
      // Horizontally overlapping but vertically separated
      const vDist = Math.max(distTop, distBottom);
      if (vDist < ISOLATED_TABLE_OFFSET) {
        const needed = ISOLATED_TABLE_OFFSET - vDist;
        if (distTop >= 0) {
          pos.y += needed;
        } else {
          pos.y -= needed;
        }
      }
    } else if (vOverlap) {
      // Vertically overlapping but horizontally separated
      const hDist = Math.max(distLeft, distRight);
      if (hDist < ISOLATED_TABLE_OFFSET) {
        const needed = ISOLATED_TABLE_OFFSET - hDist;
        if (distLeft >= 0) {
          pos.x += needed;
        } else {
          pos.x -= needed;
        }
      }
    } else {
      // Fully separated - check diagonal distance to nearest corner
      const nearestX = distLeft >= 0 ? distLeft : distRight;
      const nearestY = distTop >= 0 ? distTop : distBottom;
      const diagonalDist = Math.sqrt(nearestX * nearestX + nearestY * nearestY);
      if (diagonalDist < ISOLATED_TABLE_OFFSET) {
        const scale = ISOLATED_TABLE_OFFSET / diagonalDist;
        if (distLeft >= 0) {
          pos.x = maxX + nearestX * scale;
        } else {
          pos.x = minX - config.cardWidth - nearestX * (scale - 1);
        }
        if (distTop >= 0) {
          pos.y = maxY + nearestY * scale;
        } else {
          pos.y = minY - config.cardHeight - nearestY * (scale - 1);
        }
      }
    }
  }
}

/**
 * Clamp all positions within layout bounds.
 * Ensures 0 <= x <= canvasWidth - cardWidth and 0 <= y <= canvasHeight - cardHeight.
 */
function clampPositions(
  keys: string[],
  positions: Map<string, Position>,
  config: LayoutConfig
): void {
  const maxX = config.canvasWidth - config.cardWidth;
  const maxY = config.canvasHeight - config.cardHeight;

  for (const key of keys) {
    const pos = positions.get(key)!;
    pos.x = Math.max(0, Math.min(maxX, pos.x));
    pos.y = Math.max(0, Math.min(maxY, pos.y));
  }
}
