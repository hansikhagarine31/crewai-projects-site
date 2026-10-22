"""Registries mapping a project id to its runner, run(emitter, inputs), and, for projects with a human step, its
resumer, resume(emitter, record, decision). Both return the Markdown result, or Waiting when a person must decide."""
from collections.abc import Callable

from app.events import Runner
from app.projects import demo, p01_blog_post, p02_competitor_analysis, p03_meeting_notes, p04_data_report, p05_support_flow, p06_resume_screening, p07_bug_triage, p08_content_repurposing, p09_lead_qualification, p10_approval_report

RUNNERS: dict[str, Runner] = {
    "demo": demo.run,
    "blog-post-crew": p01_blog_post.run,
    "competitor-analysis-crew": p02_competitor_analysis.run,
    "meeting-notes-crew": p03_meeting_notes.run,
    "data-report-crew": p04_data_report.run,
    "customer-support-flow": p05_support_flow.run,
    "resume-screening-flow": p06_resume_screening.run,
    "bug-triage-flow": p07_bug_triage.run,
    "content-repurposing-flow": p08_content_repurposing.run,
    "lead-qualification-flow": p09_lead_qualification.run,
    "approval-report-flow": p10_approval_report.run,
}

RESUMERS: dict[str, Callable] = {
    "approval-report-flow": p10_approval_report.resume,
}


def get_runner(project_id: str) -> Runner | None:
    return RUNNERS.get(project_id)


def get_resumer(project_id: str) -> Callable | None:
    return RESUMERS.get(project_id)
