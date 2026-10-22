import { useEffect, useState } from 'react';
import { getHealth } from '../lib/api.js';

function describe({ ok, body }) {
  if (ok && body?.server === 'ok' && body?.agents === 'ok') {
    return { kind: 'ok', text: 'Server connected, agents connected' };
  }
  if (!body) return { kind: 'error', text: 'Server unreachable' };
  return { kind: 'error', text: `Server connected, agents unreachable${body.error ? `: ${body.error}` : ''}` };
}

/** Reports whether the server and the agents service can be reached. */
export default function ConnectionStatus() {
  const [state, setState] = useState({ kind: 'pending', text: 'Checking connection' });

  useEffect(() => {
    let active = true;
    getHealth().then((result) => {
      if (active) setState(describe(result));
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <p className={`connection connection--${state.kind}`} role="status">
      {state.text}
    </p>
  );
}
