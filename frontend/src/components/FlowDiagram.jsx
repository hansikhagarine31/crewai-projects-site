import { useMemo } from 'react';
import { useStatusAnnouncements } from '../hooks/useStatusAnnouncements.js';
import { computeLayout, describeSequence } from '../lib/layout.js';
import { statusOf } from '../lib/runState.js';
import FlowList from './FlowList.jsx';
import './FlowDiagram.css';

function SvgNode({ node, status }) {
  const { x, y, w, h, variant } = node;
  const centre = x + w / 2;
  const join = variant === 'join';

  return (
    <g className={`fd-node fd-node--${variant}`} data-status={status} style={{ '--col': node.column }}>
      <rect className="fd-halo" x={x - 4} y={y - 4} width={w + 8} height={h + 8} rx={join ? h / 2 + 4 : 16} />
      <rect className={`fd-box fd-box--${variant}`} x={x} y={y} width={w} height={h} rx={join ? h / 2 : 12} />
      {variant === 'crew' && <path className="fd-crewbar" d={`M${x + 12} ${y + 0.8} H${x + w - 12}`} />}
      {join ? (
        <text className="fd-name fd-join mono" x={centre} y={y + h / 2 + 4.5} textAnchor="middle">
          {node.label}
        </text>
      ) : (
        <>
          {node.tag && (
            <text className="fd-tag" x={centre} y={y + 24} textAnchor="middle">
              {node.tag}
            </text>
          )}
          <text className="fd-name mono" x={centre} y={y + 42} textAnchor="middle">
            {node.label}
          </text>
          {node.sublabel && (
            <text className="fd-sub" x={centre} y={y + 59} textAnchor="middle">
              {node.sublabel}
            </text>
          )}
        </>
      )}
      <g className="fd-badge fd-badge--done" transform={`translate(${x + w - 3} ${y + 3})`}>
        <circle r="9" />
        <path d="M-4 0.5 L-1.2 3.4 L4.2 -2.8" />
      </g>
      <g className="fd-badge fd-badge--error" transform={`translate(${x + w - 3} ${y + 3})`}>
        <circle r="9" />
        <path d="M-3.2 -3.2 L3.2 3.2 M3.2 -3.2 L-3.2 3.2" />
      </g>
    </g>
  );
}

/**
 * Draws a project's flow from its data: a left-to-right diagram with connectors on wide
 * screens, and the same nodes as a vertical list below 820px.
 *
 * @param {{ project: import('../data/projects.js').Project, statuses?: Record<string, string> }} props
 */
export default function FlowDiagram({ project, statuses = {} }) {
  const layout = useMemo(() => computeLayout(project), [project]);
  const announcement = useStatusAnnouncements(project, statuses);
  const idle = Object.keys(statuses).length === 0;

  return (
    <figure className="flow">
      <svg
        className="flow__svg"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={`Flow diagram: ${describeSequence(project)}`}
      >
        {layout.groupLabels.map((label) => (
          <text key={label.key} className="fd-group" x={label.x} y={label.y} textAnchor="middle">
            {label.text}
          </text>
        ))}

        {layout.edges.map((edge) => {
          const target = statusOf(statuses, edge.to);
          return (
            <g key={edge.key} className="fd-edge" data-target-status={target} style={{ '--col': 0 }}>
              <path className="fd-line" d={edge.d} pathLength="1" />
              <path className={`fd-flow ${idle || target === 'running' ? 'is-flowing' : ''}`} d={edge.d} />
            </g>
          );
        })}
        {layout.arrows.map((arrow) => (
          <polygon key={arrow.key} className="fd-arrow" points={arrow.points} data-target-status={statusOf(statuses, arrow.to)} />
        ))}

        {layout.nodes.map((node) => (
          <SvgNode key={node.id} node={node} status={statusOf(statuses, node.id)} />
        ))}
      </svg>

      <FlowList project={project} statuses={statuses} />

      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </figure>
  );
}
