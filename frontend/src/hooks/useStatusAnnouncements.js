import { useEffect, useRef, useState } from 'react';
import { STATUS_TEXT } from '../lib/runState.js';

/**
 * Returns a sentence describing the node statuses that changed since the previous render,
 * for display in an aria-live region. Nodes returning to "pending" are not announced.
 */
export function useStatusAnnouncements(project, statuses) {
  const previous = useRef({});
  const [message, setMessage] = useState('');

  useEffect(() => {
    const changes = [];
    for (const node of project.nodes) {
      const now = statuses[node.id] ?? 'pending';
      const before = previous.current[node.id] ?? 'pending';
      if (now !== before && now !== 'pending') {
        changes.push(`${node.label}: ${(STATUS_TEXT[now] ?? now).toLowerCase()}.`);
      }
    }
    previous.current = { ...statuses };
    setMessage(changes.join(' '));
  }, [project, statuses]);

  return message;
}
