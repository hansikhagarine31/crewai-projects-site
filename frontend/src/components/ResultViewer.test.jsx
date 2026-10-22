// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ResultViewer from './ResultViewer.jsx';
import SafeMarkdown, { safeUrl } from './SafeMarkdown.jsx';

afterEach(() => vi.restoreAllMocks());

const finished = (markdown, extra = {}) => ({
  runId: 'r',
  status: 'done',
  cached: false,
  result: { markdown },
  files: [],
  ...extra,
});

describe('SafeMarkdown', () => {
  const renderMarkdown = (source) => render(<SafeMarkdown>{source}</SafeMarkdown>).container;

  it('renders headings, emphasis, lists and GitHub-style tables', () => {
    const container = renderMarkdown('# Title\n\nSome **bold** text.\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n');
    expect(container.querySelector('h1')).toHaveTextContent('Title');
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('table')).toBeInTheDocument();
  });

  it('never produces raw HTML elements from the source', () => {
    const container = renderMarkdown(
      [
        '<script>window.hacked = 1</script>',
        '<img src="x" onerror="window.hacked = 2">',
        '<iframe src="https://evil.example/"></iframe>',
        '<a href="javascript:window.hacked = 3">raw link</a>',
        '<div onclick="window.hacked = 4">block</div>',
        '<style>body { display: none }</style>',
        '<svg onload="window.hacked = 5"></svg>',
      ].join('\n\n'),
    );
    for (const selector of ['script', 'img', 'iframe', 'a', 'div[onclick]', 'style', 'svg', '[onerror]', '[onload]']) {
      expect(container.querySelector(selector), selector).toBeNull();
    }
    expect(window.hacked).toBeUndefined();
  });

  it('removes links with unsafe protocols and keeps safe ones', () => {
    const container = renderMarkdown(
      [
        '[a](javascript:alert(1))',
        '[b](JaVaScRiPt:alert(1))',
        '[c](data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=)',
        '[d](vbscript:msgbox(1))',
        '[e](//evil.example/)',
        '[safe](https://example.com/page)',
        '[mail](mailto:someone@example.com)',
      ].join('\n\n'),
    );
    const hrefs = [...container.querySelectorAll('a')].map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(['https://example.com/page', 'mailto:someone@example.com']);
    expect(container).toHaveTextContent('a');
  });

  it('opens links safely in a new tab', () => {
    const link = renderMarkdown('[safe](https://example.com/)').querySelector('a');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });

  it('does not load images, which could be used to track the reader; the alternative text remains', () => {
    const container = renderMarkdown('![A chart](https://tracker.example/pixel.png)');
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('A chart');
  });

  it('escapes HTML special characters inside code', () => {
    const container = renderMarkdown('`<script>x</script>`');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('code')).toHaveTextContent('<script>x</script>');
  });

  it('keeps in-page anchors and rejects everything else through safeUrl', () => {
    expect(safeUrl('#section')).toBe('#section');
    expect(safeUrl('https://example.com')).toBe('https://example.com');
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl('/relative')).toBe('');
    expect(safeUrl(undefined)).toBe('');
  });
});

describe('ResultViewer', () => {
  it('shows a placeholder until there is a result', () => {
    render(<ResultViewer result={null} projectId="demo" />);
    expect(screen.getByText(/will appear here when a run has finished/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
  });

  it('renders the Markdown result', () => {
    render(<ResultViewer result={finished('# Report\n\nBody text.')} projectId="demo" />);
    expect(screen.getByRole('heading', { name: 'Report' })).toBeInTheDocument();
    expect(screen.getByText('Body text.')).toBeInTheDocument();
  });

  it('copies the Markdown source to the clipboard and says so', async () => {
    const user = userEvent.setup();
    // user-event installs its own clipboard when it is set up, so replace that one.
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ResultViewer result={finished('# Report')} projectId="demo" />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('# Report');
    expect(await screen.findByText('The result has been copied to the clipboard.')).toBeInTheDocument();
  });

  it('reports a failed copy instead of failing silently', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }, configurable: true });
    render(<ResultViewer result={finished('# Report')} projectId="demo" />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findAllByText(/could not be copied/)).not.toHaveLength(0);
  });

  it('downloads the Markdown as a file named after the project', async () => {
    const createObjectURL = vi.fn(() => 'blob:result');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicked = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
      clicked.push({ download: this.download, href: this.href });
    });
    const user = userEvent.setup();
    render(<ResultViewer result={finished('# Report')} projectId="blog-post-crew" />);
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(await createObjectURL.mock.calls[0][0].text()).toBe('# Report');
    expect(clicked).toEqual([{ download: 'blog-post-crew-result.md', href: 'blob:result' }]);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:result');
  });

  it('lists output files as download links with their size and type', () => {
    const files = [
      { name: 'report.md', size: 2048, contentType: 'text/markdown; charset=utf-8', url: '/api/runs/r/files/report.md' },
      { name: 'data.bin', size: 4, contentType: 'application/octet-stream', url: '/api/runs/r/files/data.bin' },
    ];
    render(<ResultViewer result={finished('x', { files })} projectId="demo" />);
    const list = within(screen.getByRole('region', { name: 'Output files' })).getAllByRole('listitem');
    expect(list).toHaveLength(2);
    const link = screen.getByRole('link', { name: 'report.md' });
    expect(link).toHaveAttribute('href', '/api/runs/r/files/report.md');
    expect(link).toHaveAttribute('download', 'report.md');
    expect(list[0]).toHaveTextContent('2.0 KB, text/markdown');
  });

  it('omits the file list when there are no files', () => {
    render(<ResultViewer result={finished('x')} projectId="demo" />);
    expect(screen.queryByText('Output files')).not.toBeInTheDocument();
  });

  it('states when the result came from the cache', () => {
    render(<ResultViewer result={finished('x', { cached: true })} projectId="demo" />);
    expect(screen.getByText(/taken from a stored copy of an earlier run/)).toBeInTheDocument();
  });

  it('offers all files as one zip download when the server provides one', () => {
    const files = [
      { name: 'a.md', size: 10, contentType: 'text/markdown', url: '/api/runs/r/files/a.md' },
      { name: 'b.md', size: 10, contentType: 'text/markdown', url: '/api/runs/r/files/b.md' },
    ];
    render(<ResultViewer result={finished('x', { files, zipUrl: '/api/runs/r/files.zip' })} projectId="demo" />);
    const link = screen.getByRole('link', { name: 'Download all files (zip)' });
    expect(link).toHaveAttribute('href', '/api/runs/r/files.zip');
    expect(link).toHaveAttribute('download');
  });

  it('shows no zip link for a single file', () => {
    const files = [{ name: 'a.md', size: 10, contentType: 'text/markdown', url: '/api/runs/r/files/a.md' }];
    render(<ResultViewer result={finished('x', { files, zipUrl: null })} projectId="demo" />);
    expect(screen.queryByRole('link', { name: /zip/ })).not.toBeInTheDocument();
  });
});
