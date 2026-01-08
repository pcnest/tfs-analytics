const { OpenAI } = require('openai');

// Initialize OpenAI client
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/**
 * Call OpenAI API with error handling and retries
 */
async function callOpenAI(messages, options = {}) {
  if (!openai) {
    throw new Error(
      'OpenAI API key not configured. Set OPENAI_API_KEY environment variable.'
    );
  }

  const defaults = {
    model: 'gpt-4o',
    temperature: 0.3,
    max_tokens: 800,
    response_format: { type: 'text' },
  };

  const config = { ...defaults, ...options };

  try {
    const response = await openai.chat.completions.create({
      ...config,
      messages,
    });

    return {
      ok: true,
      content: response.choices[0].message.content,
      usage: response.usage,
    };
  } catch (error) {
    console.error('OpenAI API error:', error);
    return {
      ok: false,
      error: error.message || 'Failed to call OpenAI API',
    };
  }
}

/**
 * Generate Release Radar Executive Report with AI insights
 */
async function generateReleaseRadarReport(radarData) {
  // radarData = array of release health rows
  // Each row: {project, release, confidencePct, qaStatus, qaPct, critical, high, medium, low, onHold, confidenceDriver, confidenceSignals, topBlockers, decisionNeeded}

  if (!radarData || radarData.length === 0) {
    return {
      ok: false,
      error: 'No Release Radar data provided',
    };
  }

  // Get current date for report
  const reportDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Calculate portfolio statistics
  const totalReleases = radarData.length;
  const goReleases = radarData.filter(
    (r) =>
      r.confidencePct >= 80 &&
      (r.onHold || 0) === 0 &&
      (r.critical || 0) === 0 &&
      (r.high || 0) === 0
  ).length;
  const watchReleases = radarData.filter((r) => {
    const isNotGo =
      r.confidencePct < 80 ||
      (r.onHold || 0) > 0 ||
      (r.critical || 0) > 0 ||
      (r.high || 0) > 0;
    const isNotNoGo =
      r.confidencePct >= 65 && (r.critical || 0) === 0 && (r.high || 0) === 0;
    return isNotGo && isNotNoGo;
  }).length;
  const noGoReleases = radarData.filter(
    (r) => r.confidencePct < 65 || (r.critical || 0) > 0 || (r.high || 0) > 0
  ).length;

  // Build context for AI
  const releaseSummaries = radarData
    .map((r) => {
      // Determine status classification
      let status = 'Go';
      if (r.confidencePct < 65 || (r.critical || 0) > 0 || (r.high || 0) > 0) {
        status = 'No-Go';
      } else if (
        r.confidencePct < 80 ||
        (r.onHold || 0) > 0 ||
        ((r.qaPct || 0) === 0 && r.qaStatus !== 'N/A')
      ) {
        status = 'Watch';
      }

      return `
Release: ${r.release} (${r.project})
- Confidence: ${r.confidencePct}%
- Status Classification: ${status}
- Driver: ${r.confidenceDriver || 'Not provided'}
- Signals: ${r.confidenceSignals || 'Not provided'}
- QA Status: ${r.qaStatus || 'Not provided'} (Pass Rate: ${r.qaPct || 0}%)
- Priority Breakdown: ${r.critical || 0} Critical, ${r.high || 0} High, ${
        r.medium || 0
      } Medium, ${r.low || 0} Low
- OnHold Items: ${r.onHold || 0}
- Top Blockers: ${r.topBlockers || 'None'}
- Decision Needed: ${r.decisionNeeded || 'None'}`;
    })
    .join('\n');

  const prompt = `You are a senior Project Manager writing an email-ready STATUS REPORT for Product Owners and stakeholders.
This report covers MULTIPLE project releases. Your job is to translate release health metrics into a high-value,
informative weekly status update: what's on track for release to QA/PROD, what's at risk if released to QA/PROD.

AUDIENCE & TONE
- Audience: Product Owners, stakeholders
- Tone: clear, calm, delivery-focused, minimal jargon
- Prioritize: release status, risks, business impacts

STRICT RULES
- Use ONLY the data provided below. Do NOT invent ticket IDs, dates, causes, or blockers.
- If a value is missing or says "Not provided", say "Not provided".
- Output must be HTML-formatted for email rendering
- Keep narrative sections tight (aim ~150–200 words per insight)
- Use proper HTML tags for formatting

STATUS CLASSIFICATION (per release)
- Go (✅): confidence >= 80% AND OnHold = 0 AND Critical = 0 AND High = 0
- Watch (⚠️): confidence 65–79% OR OnHold > 0 OR QA% = 0 when QA has items
- No-Go (⚠️): confidence < 65% OR Critical > 0 OR High > 0

CONFIDENCE SCORE CALIBRATION:
- 90-100%: Exceptional - all signals green, ahead of schedule
- 80-89%: Healthy - normal release candidate, minor issues
- 65-79%: Concerning - requires PO attention, may slip
- <65%: Critical - release at risk, escalation needed

PORTFOLIO STATISTICS:
- Total Releases: ${totalReleases}
- Go (✅): ${goReleases}
- Watch (⚠️): ${watchReleases}
- No-Go (⚠️): ${noGoReleases}

RELEASE HEALTH DATA:
${releaseSummaries}

WHAT TO PRODUCE (STATUS REPORT STRUCTURE — follow exactly):

1) Report title: 
<h2>Release Radar as of ${reportDate}</h2>

2) Project Release Status (HTML table):
Create an HTML table with columns: Project | Release | Confidence | QA Pass Rate | Signals
- Include status emoji (✅ or ⚠️) with the release name
- Show all releases
- Use proper <table>, <thead>, <tbody>, <tr>, <th>, <td> tags
- Add basic styling: border="1" cellpadding="8" cellspacing="0"

3) Release Confidence Analysis (HTML table):
Create an HTML table with columns: Project | Release | Status | Insights

For <Insights> per release, provide a concise ~150-200 word analysis that:
a) ROOT CAUSE: What data/signals drive the confidence score (do NOT repeat the confidence percentage)
b) What it means for release timing/quality
c) What stakeholder decision or action is needed (focus on PO/Stakeholder decisions, NOT Engineering/QA tasks)

INSIGHT QUALITY RULES:
• Must answer: "Can we release?" and "What's the risk if we do?"
• Do NOT repeat confidence percentage in the insight text
• Do NOT use labels like "BUSINESS IMPACT:" or "RECOMMENDED ACTION:"
• Write naturally - weave business impact and stakeholder actions into flowing narrative
• Must be actionable by PO/Stakeholder (not technical tasks for Engineering/QA)
• Ground every statement in provided data
• Never mention individual ticket IDs - speak in terms of counts and patterns

GOOD INSIGHT EXAMPLES:
• "The presence of 2 High severity items combined with 3 On-Hold items gates release readiness, even though QA completion is high at 85%. Releasing to PROD now risks customer-facing issues. Stakeholders need to review these High severity items and determine if they must be resolved before release or can be deferred to the next sprint."
• "Clean signals with no High/Critical/On-Hold items and complete QA at 100% make this the most straightforward release candidate. Low risk for on-time delivery. Proceed to PROD release as planned."
• "The Watch classification stems from 1 High severity item and 1 On-Hold item, despite 90% QA completion. The release may slip the target date if the High severity item requires immediate resolution. Stakeholders should assess the business risk of releasing with this known issue versus delaying for a fix."

BAD EXAMPLES (DO NOT DO):
• Do NOT write: "Confidence is 90%..." (don't repeat the percentage)
• Do NOT write: "BUSINESS IMPACT: Cannot release..." (don't use labels)
• Do NOT write: "RECOMMENDED ACTION: PO to..." (don't use labels)
• Do NOT write: "Team is working hard" - stakeholders assume this
• Do NOT write: "Engineering needs to fix bugs" - too vague
• Avoid technical jargon: "refactoring", "technical debt", "deployment pipeline"
• Avoid blame language: "QA is behind", "Dev missed deadline"

4) Top Blockers (HTML table - ONLY IF BLOCKERS EXIST):
Create an HTML table with columns: Project | Release | Top Blockers
- Only display releases with Top Blockers
- If no releases have blockers, exclude this section entirely

OUTPUT FORMATTING:
- Use HTML formatting throughout: <h2>, <h3>, <table>, <p>, <br>
- Tables must have proper structure with <thead> and <tbody>
- Add spacing between sections using <br> tags
- Ensure email-ready HTML formatting`;

  const messages = [
    {
      role: 'system',
      content:
        'You are a senior Project Manager who creates clear, actionable, email-ready status reports for Product Owners and stakeholders. You translate technical metrics into business impact and surface only the decisions that stakeholders can act on.',
    },
    { role: 'user', content: prompt },
  ];

  const result = await callOpenAI(messages, {
    max_tokens: 3000,
    temperature: 0.3,
  });

  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    summary: result.content,
    releases: radarData,
    usage: result.usage,
  };
}

/**
 * Generate release summary with AI
 */
async function generateReleaseSummary(releaseData) {
  const { release, metrics, details, trends } = releaseData;

  const prompt = `Analyze this software release and provide a concise executive summary (3-4 sentences).

Release: ${release}

Key Metrics:
- Overall Health Score: ${metrics.overallScore?.value}% (${
    metrics.overallScore?.status
  })
- Scope Stability: ${metrics.scopeStability?.value}%
- Predictability: ${metrics.predictability?.value}%
- Confidence: ${metrics.confidence?.value}%
- QA Pass Rate: ${metrics.qaPct?.value}% (${metrics.qaPct?.pass}/${
    metrics.qaPct?.total
  })
- Blocked Items: ${metrics.blockedPct?.value}%
- ETA: ${
    metrics.etaDays?.value !== null
      ? metrics.etaDays.value + ' days'
      : 'Unknown'
  }

Scope:
- Baseline: ${details.baseline} items
- Added: ${details.added} items
- Removed: ${details.removed} items
- Completed: ${details.delivered} items
- Remaining: ${details.remaining} items

Trends:
${
  trends
    ? `- Velocity: ${trends.velocity || 'N/A'}
- Bugs: ${trends.bugs || 'N/A'}`
    : '- No trend data available'
}

Focus on:
1. Overall status (on track / at risk / critical)
2. Key strengths
3. Primary concerns
4. One actionable recommendation

Keep it executive-friendly and data-driven.`;

  const messages = [
    {
      role: 'system',
      content:
        'You are an expert software project analyst providing concise executive summaries. Be direct, data-driven, and actionable.',
    },
    {
      role: 'user',
      content: prompt,
    },
  ];

  return await callOpenAI(messages, { max_tokens: 500 });
}

/**
 * Generate risk analysis with recommendations
 */
async function generateRiskAnalysis(releaseData) {
  const { release, metrics, details, warnings, trends } = releaseData;

  const prompt = `Identify the top 3 risks for this software release and provide specific action items.

Release: ${release}

Metrics:
- Health Score: ${metrics.overallScore?.value}%
- Scope Stability: ${metrics.scopeStability?.value}%
- Predictability: ${metrics.predictability?.value}%
- Confidence: ${metrics.confidence?.value}%
- QA Pass Rate: ${metrics.qaPct?.value}%
- Blocked Items: ${metrics.blockedPct?.value}% (${details.blocked} items)
- Critical Bugs: ${details.criticalBugs || 0}

Scope Changes:
- ${details.added} items added (${Math.round(
    (details.added / Math.max(details.baseline, 1)) * 100
  )}% increase)
- ${details.removed} items removed

Warnings:
${
  warnings && warnings.length > 0
    ? warnings.map((w) => `- ${w}`).join('\n')
    : '- None'
}

Trends:
${
  trends
    ? `- Velocity: ${trends.velocity || 'stable'}
- Bugs: ${trends.bugs || 'stable'}
- Blockers: ${trends.blockers || 'stable'}`
    : '- No trend data'
}

Provide:
1. Top 3 risks (ranked by severity)
2. Specific action for each risk
3. Who should own each action (e.g., PO, Engineering Lead, QA)

Format as:
**Risk 1:** [Description]
**Action:** [Specific action]
**Owner:** [Role]`;

  const messages = [
    {
      role: 'system',
      content:
        'You are a technical project risk analyst. Identify concrete risks and provide actionable recommendations with clear ownership.',
    },
    {
      role: 'user',
      content: prompt,
    },
  ];

  return await callOpenAI(messages, { max_tokens: 600 });
}

/**
 * Generate executive report for all active releases
 */
async function generateExecutiveReport(releasesData, options = {}) {
  const { format = 'text' } = options;

  // Build portfolio overview
  const total = releasesData.length;
  const onTrack = releasesData.filter(
    (r) => r.metrics.overallScore?.value >= 80
  ).length;
  const atRisk = releasesData.filter(
    (r) =>
      r.metrics.overallScore?.value >= 60 && r.metrics.overallScore?.value < 80
  ).length;
  const critical = releasesData.filter(
    (r) => r.metrics.overallScore?.value < 60
  ).length;

  // Get individual summaries
  const summaries = [];
  for (const releaseData of releasesData) {
    const summary = await generateReleaseSummary(releaseData);
    if (summary.ok) {
      summaries.push({
        release: releaseData.release,
        health: releaseData.metrics.overallScore?.value || 0,
        status: releaseData.metrics.overallScore?.status || 'unknown',
        summary: summary.content,
      });
    }
  }

  // Build prompt for portfolio risks
  const portfolioPrompt = `Based on these ${total} active software releases, identify the top 3 portfolio-level risks:

${summaries
  .map(
    (s, i) => `${i + 1}. ${s.release} (Health: ${s.health}%)
${s.summary}
`
  )
  .join('\n')}

Provide:
1. Top 3 portfolio-wide risks (not individual release issues)
2. Recommended actions for leadership

Be concise and actionable.`;

  const portfolioMessages = [
    {
      role: 'system',
      content:
        'You are a portfolio manager analyzing risks across multiple software releases. Focus on systemic issues and cross-cutting concerns.',
    },
    {
      role: 'user',
      content: portfolioPrompt,
    },
  ];

  const portfolioRisks = await callOpenAI(portfolioMessages, {
    max_tokens: 500,
  });

  return {
    ok: true,
    overview: {
      total,
      onTrack,
      atRisk,
      critical,
      onTrackPct: Math.round((onTrack / total) * 100),
      atRiskPct: Math.round((atRisk / total) * 100),
      criticalPct: Math.round((critical / total) * 100),
    },
    releases: summaries,
    portfolioRisks: portfolioRisks.ok
      ? portfolioRisks.content
      : 'Unable to generate portfolio risks',
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  callOpenAI,
  generateReleaseSummary,
  generateRiskAnalysis,
  generateExecutiveReport,
  generateReleaseRadarReport,
};
