import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './SafeMarkdown.css';

const ALLOWED_PROTOCOLS = /^(https?:|mailto:)/i;

/** Only absolute http, https and mailto links, and in-page anchors, are kept. */
export function safeUrl(url) {
  if (typeof url !== 'string') return '';
  if (url.startsWith('#')) return url;
  return ALLOWED_PROTOCOLS.test(url.trim()) ? url : '';
}

const components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Images would load remote content chosen by scraped pages, so only their alternative text is shown.
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
};

/**
 * Renders Markdown without ever producing raw HTML: HTML in the source is dropped, not
 * interpreted, links are limited to safe protocols, and images are not loaded.
 */
export default function SafeMarkdown({ children }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeUrl} components={components}>
        {children}
      </Markdown>
    </div>
  );
}
