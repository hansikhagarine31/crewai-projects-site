/**
 * Project definitions, transcribed from design/reference.html. Node ids equal the
 * nodeIds in shared/projects.json (checked by `npm test` in frontend/).
 *
 * @typedef {'input' | 'step' | 'crew' | 'router' | 'join' | 'dashed' | 'output'} NodeVariant
 *
 * @typedef {Object} FlowNode
 * @property {string} id        Event nodeId; equal to the id in shared/projects.json.
 * @property {number} column    Zero-based column, left to right. A join pill occupies a full column.
 * @property {number} row       Vertical position in rows of 100 units; may be fractional (0.5 centres a node between rows 0 and 1).
 * @property {NodeVariant} variant
 * @property {string} [tag]     Small heading, for example "Agent 1" or "@listen(\"billing\")".
 * @property {string} label     Main text, shown in the monospaced face.
 * @property {string} [sublabel]
 *
 * @typedef {Object} FlowEdge
 * @property {string} from      Node id.
 * @property {string} to        Node id.
 *
 * @typedef {Object} FlowGroup  A label over the nodes of one column that run in parallel or compete.
 * @property {string} label
 * @property {number} column
 * @property {string[]} nodeIds
 *
 * @typedef {Object} InputField  The same definition as in shared/projects.json.
 * @property {string} key
 * @property {string} label
 * @property {'text' | 'url' | 'urls' | 'file' | 'select'} type
 * @property {boolean} required
 * @property {number} [minLength]   text
 * @property {number} [maxLength]   text
 * @property {boolean} [multiline]  text: render a textarea
 * @property {number} [minItems]    urls
 * @property {number} [maxItems]    urls
 * @property {string[]} [extensions] file: accepted extensions, for example ".txt"
 * @property {number} [maxFiles]    file
 * @property {string} [textInto]    file: the server reads the file as text and passes it in this text input
 * @property {string} [hint]        extra guidance shown under the field
 * @property {boolean} [asText]     file: the server extracts the text of each file and passes { name, text }
 * @property {Array<{ value: string, label: string }>} [options]  select
 *
 * @typedef {Object} Project
 * @property {string} id
 * @property {number} number
 * @property {string} title
 * @property {'Crew' | 'Flow' | 'Flow + Crews'} kind
 * @property {string} pattern
 * @property {string} problem
 * @property {string} freeTools
 * @property {boolean} runnable  False until the project has a runner on the agents service.
 * @property {string} [notice]    A visible note shown on the project page, for example a limit on how the output may be used.
 * @property {string[]} [requireAnyOf]  Keys of inputs of which at least one must be supplied.
 * @property {InputField[]} inputs
 * @property {FlowNode[]} nodes
 * @property {FlowEdge[]} edges
 * @property {FlowGroup[]} groups
 */

/** @type {Project[]} */
export const projects = [
  {
    id: 'blog-post-crew',
    number: 1,
    title: 'Blog Post Crew',
    kind: 'Crew',
    pattern: 'Sequential',
    problem: 'Writing a well-researched blog post takes hours of searching, drafting and editing for every single topic.',
    freeTools: 'Gemini free tier, DuckDuckGo search tool, FileWriterTool',
    runnable: true,
    inputs: [
      { key: 'topic', label: 'Topic', type: 'text', required: true, minLength: 3, maxLength: 200 },
    ],
    nodes: [
      { id: 'input', column: 0, row: 0, variant: 'input', tag: 'Input', label: 'topic', sublabel: 'e.g. AI in farming' },
      { id: 'researcher', column: 1, row: 0, variant: 'step', tag: 'Agent 1', label: 'Researcher', sublabel: 'DuckDuckGo search' },
      { id: 'writer', column: 2, row: 0, variant: 'step', tag: 'Agent 2', label: 'Writer', sublabel: '600-word draft' },
      { id: 'editor', column: 3, row: 0, variant: 'step', tag: 'Agent 3', label: 'Editor', sublabel: 'Fixes tone and facts' },
      { id: 'output', column: 4, row: 0, variant: 'output', tag: 'Output', label: 'blog_post.md', sublabel: 'Saved by FileWriter' },
    ],
    edges: [
      { from: 'input', to: 'researcher' },
      { from: 'researcher', to: 'writer' },
      { from: 'writer', to: 'editor' },
      { from: 'editor', to: 'output' },
    ],
    groups: [],
  },
  {
    id: 'competitor-analysis-crew',
    number: 2,
    title: 'Competitor Analysis Crew',
    kind: 'Crew',
    pattern: 'Hierarchical',
    problem: 'Tracking what competitors ship, charge and say takes hours of manual browsing every week.',
    freeTools: 'Gemini free tier, ScrapeWebsiteTool, DuckDuckGo search tool',
    runnable: true,
    inputs: [
      { key: 'competitors', label: 'Competitor websites', type: 'urls', required: true, minItems: 1, maxItems: 3 },
    ],
    nodes: [
      { id: 'input', column: 0, row: 1, variant: 'input', tag: 'Input', label: 'competitors', sublabel: '3 website URLs' },
      { id: 'manager', column: 1, row: 1, variant: 'step', tag: 'Manager agent', label: 'manager_llm', sublabel: 'Splits and assigns' },
      { id: 'site_scraper', column: 2, row: 0, variant: 'step', tag: 'Agent', label: 'Site Scraper', sublabel: 'ScrapeWebsiteTool' },
      { id: 'pricing_analyst', column: 2, row: 1, variant: 'step', tag: 'Agent', label: 'Pricing Analyst', sublabel: 'Reads plans, prices' },
      { id: 'news_analyst', column: 2, row: 2, variant: 'step', tag: 'Agent', label: 'News Analyst', sublabel: 'DuckDuckGo search' },
      { id: 'strategist', column: 3, row: 1, variant: 'step', tag: 'Agent', label: 'Strategist', sublabel: 'Builds a SWOT table' },
      { id: 'output', column: 4, row: 1, variant: 'output', tag: 'Output', label: 'report.md', sublabel: 'Saved by FileWriter' },
    ],
    edges: [
      { from: 'input', to: 'manager' },
      { from: 'manager', to: 'site_scraper' },
      { from: 'manager', to: 'pricing_analyst' },
      { from: 'manager', to: 'news_analyst' },
      { from: 'site_scraper', to: 'strategist' },
      { from: 'pricing_analyst', to: 'strategist' },
      { from: 'news_analyst', to: 'strategist' },
      { from: 'strategist', to: 'output' },
    ],
    groups: [
      { label: 'Delegated in parallel', column: 2, nodeIds: ['site_scraper', 'pricing_analyst', 'news_analyst'] },
    ],
  },
  {
    id: 'meeting-notes-crew',
    number: 3,
    title: 'Meeting Notes Crew',
    kind: 'Crew',
    pattern: 'Parallel tasks',
    problem: 'After every meeting someone must write the summary and chase action items, and details get lost.',
    freeTools: 'Gemini free tier, FileReadTool, FileWriterTool',
    runnable: true,
    requireAnyOf: ['transcript', 'transcript_file'],
    inputs: [
      { key: 'transcript', label: 'Meeting transcript', type: 'text', required: true, minLength: 20, maxLength: 30000, multiline: true },
      { key: 'transcript_file', label: 'Transcript file', type: 'file', required: false, extensions: ['.txt'], maxFiles: 1, textInto: 'transcript', hint: 'The text of the file is used as the transcript. If a transcript is also pasted above, the file is used instead.' },
    ],
    nodes: [
      { id: 'input', column: 0, row: 1, variant: 'input', tag: 'Input', label: 'transcript.txt', sublabel: 'FileReadTool' },
      { id: 'summarizer', column: 1, row: 0, variant: 'step', tag: 'Task', label: 'Summarizer', sublabel: '5-line summary' },
      { id: 'action_finder', column: 1, row: 1, variant: 'step', tag: 'Task', label: 'Action Finder', sublabel: 'Owner and due date' },
      { id: 'decision_logger', column: 1, row: 2, variant: 'step', tag: 'Task', label: 'Decision Logger', sublabel: 'Decisions made' },
      { id: 'formatter', column: 2, row: 1, variant: 'step', tag: 'Agent', label: 'Formatter', sublabel: 'Waits for all three' },
      { id: 'output', column: 3, row: 1, variant: 'output', tag: 'Output', label: 'notes.md', sublabel: 'Summary, actions, decisions' },
    ],
    edges: [
      { from: 'input', to: 'summarizer' },
      { from: 'input', to: 'action_finder' },
      { from: 'input', to: 'decision_logger' },
      { from: 'summarizer', to: 'formatter' },
      { from: 'action_finder', to: 'formatter' },
      { from: 'decision_logger', to: 'formatter' },
      { from: 'formatter', to: 'output' },
    ],
    groups: [
      { label: 'async_execution=True', column: 1, nodeIds: ['summarizer', 'action_finder', 'decision_logger'] },
    ],
  },
  {
    id: 'data-report-crew',
    number: 4,
    title: 'Data Report Crew',
    kind: 'Crew',
    pattern: 'Structured output',
    problem: 'Weekly sales CSV files pile up, and turning them into a readable report is slow, repetitive work.',
    freeTools: 'Gemini free tier, FileReadTool, a custom pandas tool',
    runnable: true,
    inputs: [
      { key: 'sales', label: 'Sales data', type: 'file', required: true, extensions: ['.csv'], maxFiles: 1, textInto: 'csv' },
    ],
    nodes: [
      { id: 'input', column: 0, row: 0, variant: 'input', tag: 'Input', label: 'sales.csv', sublabel: 'FileReadTool' },
      { id: 'data_analyst', column: 1, row: 0, variant: 'step', tag: 'Agent 1', label: 'Data Analyst', sublabel: 'output_pydantic stats' },
      { id: 'insight_writer', column: 2, row: 0, variant: 'step', tag: 'Agent 2', label: 'Insight Writer', sublabel: 'Top 3 findings' },
      { id: 'reviewer', column: 3, row: 0, variant: 'step', tag: 'Agent 3', label: 'Reviewer', sublabel: 'Checks every number' },
      { id: 'output', column: 4, row: 0, variant: 'output', tag: 'Output', label: 'report.md', sublabel: 'Saved by FileWriter' },
    ],
    edges: [
      { from: 'input', to: 'data_analyst' },
      { from: 'data_analyst', to: 'insight_writer' },
      { from: 'insight_writer', to: 'reviewer' },
      { from: 'reviewer', to: 'output' },
    ],
    groups: [],
  },
  {
    id: 'customer-support-flow',
    number: 5,
    title: 'Customer Support Flow',
    kind: 'Flow',
    pattern: 'Router',
    problem: 'Support tickets arrive mixed together, and each one has to be read, sorted and sent to the right person.',
    freeTools: 'Gemini free tier, plain Python state, no paid tools',
    runnable: true,
    inputs: [
      { key: 'ticket_text', label: 'Support ticket', type: 'text', required: true, minLength: 10, maxLength: 4000, multiline: true },
    ],
    nodes: [
      { id: 'receive_ticket', column: 0, row: 1, variant: 'input', tag: '@start()', label: 'receive_ticket', sublabel: 'Fills the ticket state' },
      { id: 'categorize_ticket', column: 1, row: 1, variant: 'step', tag: '@listen(receive_ticket)', label: 'categorize_ticket', sublabel: 'Direct LLM call' },
      { id: 'route_by_category', column: 2, row: 1, variant: 'router', tag: '@router', label: 'route_by_category', sublabel: 'Returns a label' },
      { id: 'handle_billing', column: 3, row: 0, variant: 'step', tag: '@listen("billing")', label: 'handle_billing', sublabel: 'priority = high' },
      { id: 'handle_access', column: 3, row: 1, variant: 'step', tag: '@listen("account_access")', label: 'handle_access', sublabel: 'priority = high' },
      { id: 'handle_other', column: 3, row: 2, variant: 'dashed', tag: '@listen("other")', label: 'handle_other', sublabel: 'technical, feature' },
      { id: 'or_', column: 4, row: 1, variant: 'join', label: 'or_' },
      { id: 'resolve_ticket', column: 5, row: 1, variant: 'output', tag: '@listen(or_)', label: 'resolve_ticket', sublabel: 'Returns resolution' },
    ],
    edges: [
      { from: 'receive_ticket', to: 'categorize_ticket' },
      { from: 'categorize_ticket', to: 'route_by_category' },
      { from: 'route_by_category', to: 'handle_billing' },
      { from: 'route_by_category', to: 'handle_access' },
      { from: 'route_by_category', to: 'handle_other' },
      { from: 'handle_billing', to: 'or_' },
      { from: 'handle_access', to: 'or_' },
      { from: 'handle_other', to: 'or_' },
      { from: 'or_', to: 'resolve_ticket' },
    ],
    groups: [
      { label: 'One label wins', column: 3, nodeIds: ['handle_billing', 'handle_access', 'handle_other'] },
    ],
  },
  {
    id: 'resume-screening-flow',
    number: 6,
    title: 'Resume Screening Flow',
    kind: 'Flow',
    pattern: 'Router',
    problem: 'One job post brings hundreds of resumes, and reading each one takes recruiters days.',
    freeTools: 'Gemini free tier, FileReadTool, a free PDF text reader',
    runnable: true,
    notice: 'The output of this project is advice to a human reviewer. It is not a hiring decision. Every candidate must be assessed by a person, who may disagree with any score, summary or draft.',
    inputs: [
      { key: 'job_description', label: 'Job description', type: 'text', required: true, minLength: 20, maxLength: 5000, multiline: true },
      { key: 'resumes', label: 'Resumes', type: 'file', required: true, extensions: ['.pdf', '.txt'], maxFiles: 5, asText: true, hint: 'The text of each file is extracted by the server. Scanned documents (images) cannot be read.' },
    ],
    nodes: [
      { id: 'load_resumes', column: 0, row: 0.5, variant: 'input', tag: '@start()', label: 'load_resumes', sublabel: 'Reads each file' },
      { id: 'score_resume', column: 1, row: 0.5, variant: 'step', tag: '@listen(load_resumes)', label: 'score_resume', sublabel: 'Direct LLM, 0 to 10' },
      { id: 'check_score', column: 2, row: 0.5, variant: 'router', tag: '@router', label: 'check_score', sublabel: 'Score 7 or more?' },
      { id: 'summary_crew', column: 3, row: 0, variant: 'crew', tag: '@listen("shortlist")', label: 'Summary Crew', sublabel: 'Strengths and gaps' },
      { id: 'draft_rejection', column: 3, row: 1, variant: 'step', tag: '@listen("reject")', label: 'draft_rejection', sublabel: 'Polite email' },
      { id: 'or_', column: 4, row: 0.5, variant: 'join', label: 'or_' },
      { id: 'save_results', column: 5, row: 0.5, variant: 'output', tag: '@listen(or_)', label: 'save_results', sublabel: 'results.csv' },
    ],
    edges: [
      { from: 'load_resumes', to: 'score_resume' },
      { from: 'score_resume', to: 'check_score' },
      { from: 'check_score', to: 'summary_crew' },
      { from: 'check_score', to: 'draft_rejection' },
      { from: 'summary_crew', to: 'or_' },
      { from: 'draft_rejection', to: 'or_' },
      { from: 'or_', to: 'save_results' },
    ],
    groups: [
      { label: 'One label wins', column: 3, nodeIds: ['summary_crew', 'draft_rejection'] },
    ],
  },
  {
    id: 'bug-triage-flow',
    number: 7,
    title: 'Bug Triage Flow',
    kind: 'Flow + Crews',
    pattern: 'Router',
    problem: 'Issues pile up in the tracker without labels, so urgent bugs sit unseen next to feature requests.',
    freeTools: 'Gemini free tier, ScrapeWebsiteTool for the docs',
    runnable: true,
    notice: 'Nothing is posted to GitHub. This page shows a suggested label and a draft comment for a person to review and copy.',
    inputs: [
      { key: 'title', label: 'Issue title', type: 'text', required: true, minLength: 3, maxLength: 200 },
      { key: 'body', label: 'Issue description', type: 'text', required: true, minLength: 3, maxLength: 8000, multiline: true },
      { key: 'docs_url', label: 'Documentation website', type: 'url', required: false },
    ],
    nodes: [
      { id: 'read_issue', column: 0, row: 1, variant: 'input', tag: '@start()', label: 'read_issue', sublabel: 'Title and body' },
      { id: 'classify_issue', column: 1, row: 1, variant: 'step', tag: '@listen(read_issue)', label: 'classify_issue', sublabel: 'Direct LLM call' },
      { id: 'route_type', column: 2, row: 1, variant: 'router', tag: '@router', label: 'route_type', sublabel: 'bug, feature, question' },
      { id: 'bug_crew', column: 3, row: 0, variant: 'crew', tag: '@listen("bug")', label: 'Bug Crew', sublabel: 'Severity and steps' },
      { id: 'feature_crew', column: 3, row: 1, variant: 'crew', tag: '@listen("feature")', label: 'Feature Crew', sublabel: 'Draft a user story' },
      { id: 'answer_crew', column: 3, row: 2, variant: 'crew', tag: '@listen("question")', label: 'Answer Crew', sublabel: 'Reply from the docs' },
      { id: 'or_', column: 4, row: 1, variant: 'join', label: 'or_' },
      { id: 'post_reply', column: 5, row: 1, variant: 'output', tag: '@listen(or_)', label: 'post_reply', sublabel: 'Label and comment' },
    ],
    edges: [
      { from: 'read_issue', to: 'classify_issue' },
      { from: 'classify_issue', to: 'route_type' },
      { from: 'route_type', to: 'bug_crew' },
      { from: 'route_type', to: 'feature_crew' },
      { from: 'route_type', to: 'answer_crew' },
      { from: 'bug_crew', to: 'or_' },
      { from: 'feature_crew', to: 'or_' },
      { from: 'answer_crew', to: 'or_' },
      { from: 'or_', to: 'post_reply' },
    ],
    groups: [
      { label: 'One label wins', column: 3, nodeIds: ['bug_crew', 'feature_crew', 'answer_crew'] },
    ],
  },
  {
    id: 'content-repurposing-flow',
    number: 8,
    title: 'Content Repurposing Flow',
    kind: 'Flow + Crews',
    pattern: 'and_',
    problem: 'One long article should become a LinkedIn post, a tweet thread and a newsletter, but rewriting it three times wastes a day.',
    freeTools: 'Gemini free tier, ScrapeWebsiteTool, FileWriterTool',
    runnable: true,
    requireAnyOf: ['article_url', 'article_text', 'article_file'],
    inputs: [
      { key: 'article_url', label: 'Article address', type: 'url', required: false },
      { key: 'article_text', label: 'Article text', type: 'text', required: false, minLength: 200, maxLength: 20000, multiline: true },
      { key: 'article_file', label: 'Article file', type: 'file', required: false, extensions: ['.txt'], maxFiles: 1, textInto: 'article_text', hint: 'The text of the file is used as the article. Provide an address, pasted text or a file, not more than one.' },
    ],
    nodes: [
      { id: 'load_article', column: 0, row: 1, variant: 'input', tag: '@start()', label: 'load_article', sublabel: 'URL or file' },
      { id: 'extract_points', column: 1, row: 1, variant: 'step', tag: '@listen(load_article)', label: 'extract_points', sublabel: 'Direct LLM call' },
      { id: 'linkedin_crew', column: 2, row: 0, variant: 'crew', tag: '@listen(extract_points)', label: 'LinkedIn Crew', sublabel: 'Hook, 150 words' },
      { id: 'twitter_crew', column: 2, row: 1, variant: 'crew', tag: '@listen(extract_points)', label: 'Twitter Crew', sublabel: '6-tweet thread' },
      { id: 'newsletter_crew', column: 2, row: 2, variant: 'crew', tag: '@listen(extract_points)', label: 'Newsletter Crew', sublabel: 'Intro and 3 bullets' },
      { id: 'and_', column: 3, row: 1, variant: 'join', label: 'and_' },
      { id: 'publish_pack', column: 4, row: 1, variant: 'output', tag: '@listen(and_)', label: 'publish_pack', sublabel: '3 files saved' },
    ],
    edges: [
      { from: 'load_article', to: 'extract_points' },
      { from: 'extract_points', to: 'linkedin_crew' },
      { from: 'extract_points', to: 'twitter_crew' },
      { from: 'extract_points', to: 'newsletter_crew' },
      { from: 'linkedin_crew', to: 'and_' },
      { from: 'twitter_crew', to: 'and_' },
      { from: 'newsletter_crew', to: 'and_' },
      { from: 'and_', to: 'publish_pack' },
    ],
    groups: [
      { label: 'Run side by side', column: 2, nodeIds: ['linkedin_crew', 'twitter_crew', 'newsletter_crew'] },
    ],
  },
  {
    id: 'lead-qualification-flow',
    number: 9,
    title: 'Lead Qualification Flow',
    kind: 'Flow + Crews',
    pattern: 'Router',
    problem: 'Sales teams waste time on cold leads while hot leads wait days for a reply.',
    freeTools: 'Gemini free tier, ScrapeWebsiteTool, FileWriterTool',
    runnable: true,
    notice: 'No email is sent. For a lead that scores as hot, the page shows an email draft for a person to review; nothing is sent from this service.',
    inputs: [
      { key: 'lead_name', label: 'Lead name', type: 'text', required: true, minLength: 2, maxLength: 120 },
      { key: 'company_name', label: 'Company name', type: 'text', required: true, minLength: 2, maxLength: 120 },
      { key: 'website_url', label: 'Website address', type: 'url', required: true },
    ],
    nodes: [
      { id: 'capture_lead', column: 0, row: 1, variant: 'input', tag: '@start()', label: 'capture_lead', sublabel: 'Name and website' },
      { id: 'enrich_crew', column: 1, row: 1, variant: 'crew', tag: '@listen(capture_lead)', label: 'Enrich Crew', sublabel: 'Scrapes the website' },
      { id: 'score_lead', column: 2, row: 1, variant: 'router', tag: '@router', label: 'score_lead', sublabel: 'hot, warm, cold' },
      { id: 'outreach_crew', column: 3, row: 0, variant: 'crew', tag: '@listen("hot")', label: 'Outreach Crew', sublabel: 'Personal email draft' },
      { id: 'add_to_nurture', column: 3, row: 1, variant: 'step', tag: '@listen("warm")', label: 'add_to_nurture', sublabel: 'Weekly tips list' },
      { id: 'archive_lead', column: 3, row: 2, variant: 'dashed', tag: '@listen("cold")', label: 'archive_lead', sublabel: 'Saved, no action' },
      { id: 'or_', column: 4, row: 1, variant: 'join', label: 'or_' },
      { id: 'log_lead', column: 5, row: 1, variant: 'output', tag: '@listen(or_)', label: 'log_lead', sublabel: 'leads.csv' },
    ],
    edges: [
      { from: 'capture_lead', to: 'enrich_crew' },
      { from: 'enrich_crew', to: 'score_lead' },
      { from: 'score_lead', to: 'outreach_crew' },
      { from: 'score_lead', to: 'add_to_nurture' },
      { from: 'score_lead', to: 'archive_lead' },
      { from: 'outreach_crew', to: 'or_' },
      { from: 'add_to_nurture', to: 'or_' },
      { from: 'archive_lead', to: 'or_' },
      { from: 'or_', to: 'log_lead' },
    ],
    groups: [
      { label: 'One label wins', column: 3, nodeIds: ['outreach_crew', 'add_to_nurture', 'archive_lead'] },
    ],
  },
  {
    id: 'approval-report-flow',
    number: 10,
    title: 'Approval Report Flow',
    kind: 'Flow + Crews',
    pattern: 'Human feedback',
    problem: 'Auto-generated reports are risky to publish unchecked, but reviewing every word by hand is slow.',
    freeTools: 'Gemini free tier, DuckDuckGo search tool, CrewAI 1.8+ for human feedback',
    runnable: true,
    inputs: [
      { key: 'topic', label: 'Topic', type: 'text', required: true, minLength: 3, maxLength: 200 },
      { key: 'audience', label: 'Audience', type: 'text', required: true, minLength: 3, maxLength: 200 },
    ],
    nodes: [
      { id: 'collect_topic', column: 0, row: 0.5, variant: 'input', tag: '@start()', label: 'collect_topic', sublabel: 'Topic and audience' },
      { id: 'research_crew', column: 1, row: 0.5, variant: 'crew', tag: '@listen(collect_topic)', label: 'Research Crew', sublabel: '3 agents, sources' },
      { id: 'writing_crew', column: 2, row: 0.5, variant: 'crew', tag: '@listen(research)', label: 'Writing Crew', sublabel: 'Drafts the report' },
      { id: 'review_draft', column: 3, row: 0.5, variant: 'dashed', tag: '@human_feedback', label: 'review_draft', sublabel: 'A person decides' },
      { id: 'check_decision', column: 4, row: 0.5, variant: 'router', tag: '@router', label: 'check_decision', sublabel: 'approved or revise' },
      { id: 'publish_report', column: 5, row: 0, variant: 'output', tag: '@listen("approved")', label: 'publish_report', sublabel: 'Saves final.md' },
      { id: 'revision_crew', column: 5, row: 1, variant: 'crew', tag: '@listen("revise")', label: 'Revision Crew', sublabel: 'Then back to review' },
    ],
    edges: [
      { from: 'collect_topic', to: 'research_crew' },
      { from: 'research_crew', to: 'writing_crew' },
      { from: 'writing_crew', to: 'review_draft' },
      { from: 'review_draft', to: 'check_decision' },
      { from: 'check_decision', to: 'publish_report' },
      { from: 'check_decision', to: 'revision_crew' },
    ],
    groups: [
      { label: 'One label wins', column: 5, nodeIds: ['publish_report', 'revision_crew'] },
    ],
  },
];

/**
 * The pipeline demonstration: handled entirely by the agents service, with no language model.
 * Not listed with the ten projects; reachable at /projects/demo.
 * @type {Project}
 */
export const demoProject = {
  id: 'demo',
  number: 0,
  title: 'Pipeline demonstration',
  kind: 'Crew',
  pattern: 'Sequential',
  problem: 'This page exercises the whole pipeline, from the browser through the server to the agents service, without calling a language model.',
  freeTools: 'none; no language model or search tool is used',
  runnable: true,
  inputs: [
    { key: 'topic', label: 'Topic', type: 'text', required: true, minLength: 1, maxLength: 200 },
    { key: 'notes', label: 'Notes', type: 'file', required: false, extensions: ['.txt'], maxFiles: 1 },
  ],
  nodes: [
    { id: 'topic', column: 0, row: 0, variant: 'input', tag: 'Input', label: 'topic', sublabel: 'Text from the form' },
    { id: 'plan', column: 1, row: 0, variant: 'step', tag: 'Step 1', label: 'plan', sublabel: 'Outline prepared' },
    { id: 'research', column: 2, row: 0, variant: 'step', tag: 'Step 2', label: 'research', sublabel: 'Sources reviewed' },
    { id: 'compose', column: 3, row: 0, variant: 'step', tag: 'Step 3', label: 'compose', sublabel: 'Draft composed' },
    { id: 'demo_md', column: 4, row: 0, variant: 'output', tag: 'Output', label: 'demo.md', sublabel: 'Returned as a file' },
  ],
  edges: [
    { from: 'topic', to: 'plan' },
    { from: 'plan', to: 'research' },
    { from: 'research', to: 'compose' },
    { from: 'compose', to: 'demo_md' },
  ],
  groups: [],
};

export const getProject = (id) => (id === demoProject.id ? demoProject : projects.find((project) => project.id === id));
