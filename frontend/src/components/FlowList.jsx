import { Fragment } from 'react';
import { columnsOf } from '../lib/layout.js';
import { STATUS_TEXT, statusOf } from '../lib/runState.js';

function Arrow() {
  return (
    <li className="fl-arrow" aria-hidden="true">
      <svg viewBox="0 0 28 14" className="fl-arrow__icon">
        <path d="M1 7h22M18 2l6 5-6 5" />
      </svg>
    </li>
  );
}

function Card({ node, status }) {
  return (
    <div className={`fl-card fl-card--${node.variant}`} data-status={status}>
      {node.tag && <i className="fl-tag">{node.tag}</i>}
      <b className="fl-name mono">{node.label}</b>
      {node.sublabel && <span className="fl-sub">{node.sublabel}</span>}
      {status !== 'pending' && <span className="fl-status">{STATUS_TEXT[status]}</span>}
    </div>
  );
}

/** The diagram as a vertical list, shown below 820px. Parallel nodes sit in one dashed group. */
export default function FlowList({ project, statuses }) {
  const columns = columnsOf(project);

  return (
    <ol className="fl" aria-label={`${project.title}: steps`}>
      {columns.map(({ column, nodes, group }, index) => {
        const first = nodes[0];
        let content;
        if (first.variant === 'join') {
          content = (
            <div className="fl-pill mono" data-status={statusOf(statuses, first.id)}>
              {first.label}
              {statusOf(statuses, first.id) !== 'pending' && (
                <span className="visually-hidden">: {STATUS_TEXT[statusOf(statuses, first.id)]}</span>
              )}
            </div>
          );
        } else if (nodes.length > 1) {
          content = (
            <div className="fl-group" role="group" aria-label={group}>
              {group && <span className="fl-group__label">{group}</span>}
              {nodes.map((node) => (
                <Card key={node.id} node={node} status={statusOf(statuses, node.id)} />
              ))}
            </div>
          );
        } else {
          content = <Card node={first} status={statusOf(statuses, first.id)} />;
        }

        return (
          <Fragment key={column}>
            {index > 0 && <Arrow />}
            <li className="fl-item">{content}</li>
          </Fragment>
        );
      })}
    </ol>
  );
}
