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
informative weekly status update: what's on track for release to QA/PROD, what's at risk if released to QA/PROD, and if any/applicable, what we need from stakeholders with regards to project releases.

AUDIENCE & TONE
- Audience: Product Owners, stakeholders
- Tone: clear, calm, delivery-focused, minimal jargon
- Prioritize: release status, risks, business impacts, next milestones, and where attention is needed

STRICT RULES
- Use ONLY the data provided below. Do NOT invent ticket IDs, dates, causes, or blockers.
- If a value is missing or says "Not provided", say "Not provided".
- Output must be EMAIL-READY with proper formatting.
- Keep narrative sections tight (aim ~150–250 words per insight, excluding tables).
- Use **bold** for section headers
- Use bullet points (•) for lists, not dashes
- Use ⚠️ for Watch/No-Go releases, ✅ for Go releases in tables
- Add spacing between sections for readability

STATUS CLASSIFICATION (per release)
- Go (✅): confidence >= 80% AND OnHold = 0 AND Critical = 0 AND High = 0
- Watch (⚠️): confidence 65–79% OR OnHold > 0 OR QA% = 0 when QA has items
- No-Go (⚠️): confidence < 65% OR Critical > 0 OR High > 0

CONFIDENCE SCORE CALIBRATION:
- 90-100%: Exceptional - all signals green, ahead of schedule
- 80-89%: Healthy - normal release candidate, minor issues
- 65-79%: Concerning - requires PO attention, may slip
- <65%: Critical - release at risk, escalation needed

RECOMMENDED ACTIONS BY STATUS:
- Go: Proceed to release; monitor
- Watch: Acceptable to proceed with PO sign-off; document known issues
- No-Go: DO NOT release without resolving critical items; requires escalation

PORTFOLIO STATISTICS:
- Total Releases: ${totalReleases}
- Go (✅): ${goReleases}
- Watch (⚠️): ${watchReleases}
- No-Go (⚠️): ${noGoReleases}

RELEASE HEALTH DATA:
${releaseSummaries}

WHAT TO PRODUCE (STATUS REPORT STRUCTURE — follow exactly):

1) Executive Summary (TLDR - 2-3 sentences max):
Provide immediate key takeaways: "${goReleases} of ${totalReleases} releases are on track. ${
    noGoReleases + watchReleases
  } releases require attention. Primary concern: [single biggest risk across portfolio]."

2) Greeting line:
"Hi Product Owners & Stakeholders,

Here is the summary report on the project status as of ${reportDate}, for review."

3) Report title: 
"**Release Radar as of ${reportDate}**"

4) Portfolio Health Overview (2-3 sentences):
Summarize the overall state. Identify the most common/severe issue across releases. State what needs stakeholder attention most this week.

5) Project Release Status (table):
Format: 'Project | Release | Confidence | QA Pass Rate | Signals'
- Include status emoji (✅ or ⚠️) with the release name
- Show all releases

6) Release Confidence Analysis (table):
Format: 'Project | Release | Status | Insights'

For <Insights> per release, provide a concise ~150-250 word analysis that:
a) ROOT CAUSE: What data/signals drive the confidence score
b) BUSINESS IMPACT: What it means for release timing/quality (not just technical state)
c) RECOMMENDED ACTION: What should happen next WITH clear owner (PO/Stakeholder decision)
d) CONTEXT: If confidence < 70%, note "below healthy threshold of 75%"

INSIGHT QUALITY RULES:
• Must answer: "Can we release?" and "What's the risk if we do?"
• Must be actionable by PO/Stakeholder (not technical tasks for Engineering/QA)
• Ground every statement in provided data
• Never mention individual ticket IDs - speak in terms of counts and patterns
• Frame in terms of BUSINESS IMPACT, not just technical state

GOOD INSIGHT EXAMPLES:
• "Confidence is low (62%) due to a combination of 2 High severity items + 3 On-Hold items, even though QA completion is high at 85%. This indicates work may be "tested," but release readiness remains gated by scope decisions and severity disposition. BUSINESS IMPACT: Cannot release to PROD without risking customer-facing issues. RECOMMENDED ACTION: PO to review High severity items and determine if they gate release or can be deferred to next sprint."
• "High confidence (88%) is supported by clean signals (no High/Critical/On-Hold) and complete QA (100%). This is the most straightforward release candidate from a health perspective. BUSINESS IMPACT: Low risk for on-time delivery. RECOMMENDED ACTION: Proceed to PROD release as planned."
• "Mid confidence (72%) but classified Watch because 1 High severity item is present and there is 1 On-Hold item. High QA completion (90%) reduces uncertainty, but doesn't remove the need to decide whether High items gate release. BUSINESS IMPACT: May slip target date if High severity requires fix. RECOMMENDED ACTION: PO to assess business risk of releasing with Known Issue vs. delaying for fix."

BAD EXAMPLES (DO NOT DO):
• "Team is working hard" - stakeholders assume this
• "We need to fix bugs" - too vague, no decision point
• Technical jargon: "refactoring", "technical debt", "deployment pipeline"
• Blame language: "QA is behind", "Dev missed deadline"

7) Top Blockers (table - ONLY IF BLOCKERS EXIST):
Format: 'Project | Release | Top Blockers'
- Only display releases with Top Blockers
- If no releases have blockers, exclude this section entirely

8) Decisions & Support Needed (table - ONLY IF DECISIONS NEEDED):
Format: 'Project | Release | Decision/Support Needed'

DECISION CRITERIA:
- ONLY surface decisions/asks that a PO/Stakeholder can act on
- Do NOT surface any decisions/asks related to Engineering or QA execution
- If none apply, exclude this section entirely

GOOD DECISION EXAMPLES:
• "Approve scope reduction: remove Feature X to meet release date?"
• "Approve budget for 2 additional QA resources to complete testing by Friday"
• "Accept risk: release with Known Issue Y documented in release notes?"
• "Prioritize: delay Release A to allocate resources to critical Release B?"

BAD EXAMPLES (DO NOT INCLUDE):
• "Engineering needs to fix bugs" (Engineering execution)
• "QA needs to complete testing" (QA execution)
• "Code review required" (Engineering process)

OUTPUT FORMATTING:
- Use proper spacing between all sections
- Keep tables simple (plain text, aligned columns)
- Ensure email-ready formatting throughout`;

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
