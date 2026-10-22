/** @typedef {import('../data/projects.js').Project} Project */

// Geometry follows design/reference.html: 150 x 78 nodes, 44 between columns, 100 per row.
export const GEOMETRY = {
  nodeW: 150,
  nodeH: 78,
  colGap: 44,
  rowPitch: 100,
  pad: 12,
  joinW: 84,
  joinH: 30,
  trunk: 22, // distance from a column to the vertical line where connectors fan out or merge
  labelBand: 18, // space above the diagram for group labels
  arrow: 9,
};

/**
 * Computes positions for a project's nodes, connectors and group labels.
 * Pure: the same project always gives the same layout.
 * @param {Project} project
 */
export function computeLayout(project) {
  const g = GEOMETRY;
  const columnCount = Math.max(...project.nodes.map((node) => node.column)) + 1;
  const maxRow = Math.max(...project.nodes.map((node) => node.row));
  const top = g.pad + (project.groups.length ? g.labelBand : 0);
  const columnX = (column) => g.pad + column * (g.nodeW + g.colGap);

  const nodes = project.nodes.map((node) => {
    const join = node.variant === 'join';
    const w = join ? g.joinW : g.nodeW;
    const h = join ? g.joinH : g.nodeH;
    return {
      ...node,
      w,
      h,
      // A join pill is centred in a full-width column so that connectors line up with its neighbours.
      x: columnX(node.column) + (g.nodeW - w) / 2,
      y: top + node.row * g.rowPitch + (g.nodeH - h) / 2,
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const arrowKeys = new Set();
  const edges = [];
  const arrows = [];
  for (const edge of project.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    const sx = from.x + from.w;
    const sy = from.y + from.h / 2;
    const tx = to.x;
    const ty = to.y + to.h / 2;
    let d = `M${sx} ${sy} L${tx} ${ty}`;
    if (Math.abs(sy - ty) > 0.5) {
      const trunkX = columnX(from.column) + g.nodeW + g.trunk;
      d = `M${sx} ${sy} L${trunkX} ${sy} L${trunkX} ${ty} L${tx} ${ty}`;
    }
    edges.push({ key: `${edge.from}>${edge.to}`, from: edge.from, to: edge.to, d });

    const arrowKey = `${tx},${ty}`;
    if (!arrowKeys.has(arrowKey)) {
      arrowKeys.add(arrowKey);
      arrows.push({
        key: arrowKey,
        to: edge.to,
        points: `${tx},${ty} ${tx - g.arrow},${ty - 5} ${tx - g.arrow},${ty + 5}`,
      });
    }
  }

  const groupLabels = project.groups.map((group) => {
    const members = nodes.filter((node) => group.nodeIds.includes(node.id));
    return {
      key: `${group.column}:${group.label}`,
      text: group.label,
      x: columnX(group.column) + g.nodeW / 2,
      y: Math.min(...members.map((node) => node.y)) - 7,
    };
  });

  return {
    width: g.pad * 2 + columnCount * g.nodeW + (columnCount - 1) * g.colGap,
    height: top + maxRow * g.rowPitch + g.nodeH + g.pad,
    nodes,
    edges,
    arrows,
    groupLabels,
  };
}

/**
 * Nodes grouped by column, top to bottom, with the group label of the column if it has one.
 * Used by the vertical list and by the accessible description.
 * @param {Project} project
 */
export function columnsOf(project) {
  const count = Math.max(...project.nodes.map((node) => node.column)) + 1;
  return Array.from({ length: count }, (_, column) => ({
    column,
    nodes: project.nodes.filter((node) => node.column === column).sort((a, b) => a.row - b.row),
    group: project.groups.find((group) => group.column === column)?.label,
  }));
}

/** Left-to-right description in the form used by the reference: "A to B / C to D". */
export function describeSequence(project) {
  return columnsOf(project)
    .map(({ nodes }) => nodes.map((node) => node.label).join(' / '))
    .join(' to ');
}
