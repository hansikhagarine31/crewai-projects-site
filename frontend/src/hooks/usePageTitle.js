import { useEffect } from 'react';

const SITE = 'CrewAI Projects';

export function usePageTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} - ${SITE}` : SITE;
  }, [title]);
}
