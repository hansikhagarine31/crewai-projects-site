/**
 * A safe example for each project, used by the "Sample input" button. The text and files come from shared/samples
 * (made-up material), and the web addresses are well-known public sites. Nothing here refers to a real person.
 *
 * values: values for text, url and urls inputs. files: files for file inputs, as { name, type, text }.
 */
import jobDescription from '../../../shared/samples/job-description.txt?raw';
import transcript from '../../../shared/samples/meeting-transcript.txt?raw';
import resumePartial from '../../../shared/samples/resumes/resume-partial.txt?raw';
import resumeStrong from '../../../shared/samples/resumes/resume-strong.txt?raw';
import resumeWeak from '../../../shared/samples/resumes/resume-weak.txt?raw';
import salesCsv from '../../../shared/samples/sales.csv?raw';

const ARTICLE =
  'Vertical farms grow crops indoors, in stacked layers, under controlled light. Because the water is recycled, they use much less of it than ' +
  'a field does, and because they are indoors they can be built close to the people who buy the produce. Their largest cost is energy, ' +
  'which is why they suit leafy greens and herbs better than grain. A sensible assessment weighs the saving in water and transport against ' +
  'the cost of lighting, and asks whether the energy comes from a clean source.';

export const samples = {
  'blog-post-crew': { values: { topic: 'Vertical farming for urban food supply' } },
  'competitor-analysis-crew': {
    values: { competitors: ['https://www.postgresql.org/', 'https://www.mysql.com/', 'https://www.sqlite.org/'] },
  },
  'meeting-notes-crew': { values: { transcript } },
  'data-report-crew': { files: { sales: [{ name: 'sales.csv', type: 'text/csv', text: salesCsv }] } },
  'customer-support-flow': {
    values: { ticket_text: 'I was charged twice for my subscription this month. Please refund the second payment and confirm that I will not be charged again.' },
  },
  'resume-screening-flow': {
    values: { job_description: jobDescription },
    files: {
      resumes: [
        { name: 'resume-strong.txt', type: 'text/plain', text: resumeStrong },
        { name: 'resume-partial.txt', type: 'text/plain', text: resumePartial },
        { name: 'resume-weak.txt', type: 'text/plain', text: resumeWeak },
      ],
    },
  },
  'bug-triage-flow': {
    values: {
      title: 'Export to CSV shows a blank page',
      body: 'After uploading a file and pressing Export, the page goes blank and nothing is downloaded. It happens in the latest version on every browser I tried.',
    },
  },
  'content-repurposing-flow': { values: { article_text: ARTICLE } },
  'lead-qualification-flow': {
    values: { lead_name: 'Alex Example', company_name: 'Example Company', website_url: 'https://example.com/' },
  },
  'approval-report-flow': { values: { topic: 'Vertical farming', audience: 'City planners' } },
  demo: { values: { topic: 'A sample topic' } },
};

/** Builds the form values for a project's sample, or null when there is none. Files become File objects. */
export function sampleValues(project, initial) {
  const sample = samples[project.id];
  if (!sample) return null;
  const values = { ...initial, ...(sample.values ?? {}) };
  for (const [key, files] of Object.entries(sample.files ?? {})) {
    values[key] = files.map((file) => new File([file.text], file.name, { type: file.type }));
  }
  return values;
}
