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

  // Build context for AI
  const releaseSummaries = radarData
    .map((r) => {
      return `
Release: ${r.release} (${r.project})
- Confidence: ${r.confidencePct}%
- Driver: ${r.confidenceDriver || 'N/A'}
- Signals: ${r.confidenceSignals || 'N/A'}
- QA Status: ${r.qaStatus || 'N/A'} (${r.qaPct || 0}%)
- Priority Breakdown: ${r.critical || 0} Critical, ${r.high || 0} High, ${
        r.medium || 0
      } Medium, ${r.low || 0} Low
- OnHold Items: ${r.onHold || 0}
- Top Blockers: ${r.topBlockers || 'None'}
- Decision Needed: ${r.decisionNeeded || 'N'}`;
    })
    .join('\n');

  const prompt = `You are a product delivery executive analyzing release health metrics for a weekly status report.

RELEASE HEALTH DATA:
${releaseSummaries}

Generate a concise executive summary that:
1. Highlights overall portfolio health (how many releases are on track vs at risk)
2. Identifies top 3 risks or concerns across all releases
3. Provides actionable recommendations for leadership
4. Calls out any releases requiring immediate attention

Tone: Professional, action-oriented, executive-level (avoid technical jargon)
Format: Use short paragraphs with clear headers
Length: 300-400 words`;

  const messages = [
    {
      role: 'system',
      content:
        'You are an expert product delivery executive who creates clear, actionable status reports.',
    },
    { role: 'user', content: prompt },
  ];

  const result = await callOpenAI(messages, {
    max_tokens: 1000,
    temperature: 0.4,
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
