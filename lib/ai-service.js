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
      'OpenAI API key not configured. Set OPENAI_API_KEY environment variable.',
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
  // Each row: {project, release, confidencePct, confidenceDelta, previousConfidence, qaStatus, qaPct, critical, high, medium, low, onHold, confidenceDriver, confidenceSignals, topBlockers, decisionNeeded}

  if (!radarData || radarData.length === 0) {
    return {
      ok: false,
      error: 'No Release Radar data provided',
    };
  }

  // Get current date for report
  // Align report date with Pacific time (matches client footer)
  const reportDate = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
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
      (r.high || 0) === 0,
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
    (r) => r.confidencePct < 65 || (r.critical || 0) > 0 || (r.high || 0) > 0,
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

      const deltaTrend = Number.isFinite(r.confidenceDelta)
        ? r.confidenceDelta > 0
          ? 'up'
          : r.confidenceDelta < 0
            ? 'down'
            : 'flat'
        : 'unknown';

      return `
Release: ${r.release} (${r.project})
- Confidence: ${r.confidencePct}% (7d trend: ${deltaTrend})
- Status Classification: ${status}
- Driver: ${r.confidenceDriver || 'Not provided'}
- Signals: ${r.confidenceSignals || 'Not provided'}
- QA Status: ${r.qaStatus || 'Not provided'}
- QA Pass Rate: ${r.qaPass || 0} / ${r.qaTotal || 0} (${r.qaPct || 0}%)
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
informative weekly status update: what's on track for release to QA/PRODUCTION environments, what's at risk if released to QA/PRODUCTION environments.

AUDIENCE & TONE
- Audience: Product Owners, stakeholders
- Tone: clear, calm, delivery-focused, minimal jargon
- Prioritize: release decisions, risks, and business impact — not engineering details

STRICT RULES
- Use ONLY the data provided below. Do NOT invent ticket IDs, dates, causes, or blockers.
- If a value is missing or says "Not provided", say "Not provided".
- Output must be HTML-formatted for email rendering
- Use proper HTML tags for formatting.
- CRITICAL: Do NOT wrap your output in code fences — output raw HTML only!

STATUS CLASSIFICATION (per release)
- Go (🟢): confidence >= 80% AND OnHold = 0 AND Critical = 0 AND High = 0
- Watch (🟠): confidence 65-79% OR OnHold > 0 OR QA% = 0 when QA has items
- No-Go (🔴): confidence < 65% OR Critical > 0 OR High > 0

QA PASS RATE INTERPRETATION — CRITICAL, apply this logic consistently:
- QA Pass Rate = 0% AND QA Total = 0: Release has NO QA items — this release is likely targeting a QA environment deployment (not PROD). Do NOT flag as a QA concern.
- QA Pass Rate = 0% AND QA Total > 0: QA testing has NOT yet started in the QA environment. Items exist but none have been validated. Flag as a Watch signal — release is not ready for PROD.
- QA Pass Rate > 0% AND QA Total > 0: QA is in progress or complete. This release is progressing toward or is ready for a PRODUCTION deployment. Use pass/total ratio to assess readiness.
- Never describe "0% QA Pass Rate" as a failure — distinguish between "no QA items" and "QA not yet started".

DEPLOYMENT STAGE INFERENCE (use in insights and signals):
- QA Total = 0 → likely targeting QA environment deployment
- QA Total > 0, QA Pass Rate = 0% → QA environment active, PROD deployment not yet viable
- QA Total > 0, QA Pass Rate > 0% and < 100% → QA in progress, PROD deployment approaching
- QA Total > 0, QA Pass Rate = 100% → QA complete, release is a PROD deployment candidate

CONFIDENCE SCORE CALIBRATION:
- 90-100%: Exceptional - all signals green, ahead of schedule
- 80-89%: Healthy - normal release candidate, minor issues
- 65-79%: Concerning - requires PO attention, may slip
- <65%: Critical - release at risk, escalation needed

TREND CALIBRATION (7-day delta):
- "up": confidence improved since last report — positive signal
- "down": confidence declined since last report — investigate why
- "flat" or "unknown": no meaningful change

PORTFOLIO STATISTICS:
- Total Releases: ${totalReleases}
- Go (🟢): ${goReleases}
- Watch (🟠): ${watchReleases}
- No-Go (🔴): ${noGoReleases}

RELEASE HEALTH DATA:
${releaseSummaries}

WHAT TO PRODUCE (STATUS REPORT STRUCTURE — follow exactly):

1) Report title: 
<h2>Release Radar as of ${reportDate}</h2>

2) Project Release Status (HTML table):
Create an HTML table with columns: Project | Release | Confidence | QA Pass Rate | Signals
- Release column should contain ONLY the release name (no status emoji)
- Confidence: Show percent + trend arrow. Use <span style="color:#0a7c2f">↑</span> for up, <span style="color:#b42318">↓</span> for down, <span style="color:#4b5563">—</span> for flat/unknown. Example: "87% <span style="color:#0a7c2f">↑</span>"
- QA Pass Rate format: pass / total (pct%), e.g. "12 / 20 (60%)"
- Signals: short phrase summarizing the dominant signal. Apply DEPLOYMENT STAGE INFERENCE:
  • QA Total = 0 → "Targeting QA environment"
  • QA not started → "QA not yet started"
  • QA in progress → "QA in progress ([pct]% pass)"
  • QA complete → "QA complete — PROD ready" (if other signals are clean)
  • Override with severity signals if present: "2 High items", "3 On-Hold items blocking"

Table styling: border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%"
Use <thead> / <tbody>. Show ALL releases.

3) Release Confidence Analysis (HTML table):
Create an HTML table with columns: Project | Release | Status | Deployment Stage | Insights

Column rules:
- Status: emoji + label (e.g., "🟢 Go", "🟠 Watch", "🔴 No-Go")
- Deployment Stage: infer from QA PASS RATE INTERPRETATION and DEPLOYMENT STAGE INFERENCE:
  • "QA Environment" — QA Total = 0 (release is being deployed to QA, not PROD)
  • "QA In Progress" — QA Total > 0 and pass rate = 0% (QA env active, testing underway or not yet started)
  • "QA → PROD" — QA Total > 0 and 0% < pass rate < 100% (approaching PROD readiness)
  • "PROD Candidate" — QA Total > 0 and pass rate = 100% (QA complete, ready for PROD)
- Insights: see INSIGHT RULES below

INSIGHT RULES — write ~120-180 words per release (allow up to 200 words for No-Go):

Structure each insight to naturally cover all of the following (do NOT use section labels):

a) DEPLOYMENT CONTEXT: Open by framing where this release stands in the deployment lifecycle.
   - If QA Total = 0: "This release is targeting the QA environment — QA pass rate is not yet applicable."
   - If QA not started: "QA testing has not yet begun in the QA environment, making a PROD deployment premature at this stage."
   - If QA in progress: reference pass/total to convey how far along QA validation is.
   - If QA complete: note that QA validation is done and this is a PROD deployment candidate.

b) TREND CONTEXT: Weave the 7-day confidence trend naturally into the narrative — do not label it.
   - If trend is "up": acknowledge the positive momentum and what it signals (e.g., "momentum has improved over the past week, suggesting items are being resolved")
   - If trend is "down": surface it as a concern that warrants attention (e.g., "confidence has slipped over the past week, which warrants a closer look at what has changed")
   - If trend is "flat" or "unknown": omit entirely or briefly note stability if relevant
   - NEVER write "Week-over-Week:" or "7-day trend:" as a label — fold it naturally into the prose

c) SIGNAL SUMMARY: What specific data signals drive this classification?
   - Reference counts (e.g., "2 High severity items", "3 On-Hold items", "QA at 85%")
   - Mention Medium/Low item counts only if they contribute to a risk pattern
   - Use the trend to strengthen or challenge the current signal (e.g., "despite improving momentum, 2 High severity items remain unresolved")

d) RELEASE RISK: What happens if the release ships to its target environment now?
   - For QA environment deployments: assess readiness to enter QA (are there blockers that would prevent a stable QA cycle?)
   - For PROD candidates: assess risk of customer-facing impact
   - For Go releases: confirm it is low-risk and environment-ready
   - For Watch/No-Go: articulate what could go wrong for end users or the business

   e) DECISION OR AWARENESS NEEDED — apply based on deployment target:

   PROD-TARGETING releases (Deployment Stage = "QA → PROD" or "PROD Candidate"):
   - These releases are approaching or ready for PROD — stakeholder decisions ARE required.
   - For No-Go 🔴: State the specific decision stakeholders must make (e.g., hold the release date, defer scope, escalate blockers).
   - For Watch 🟠: State what PO should pre-decide or monitor in case status degrades before the PROD release.
   - For Go 🟢: Confirm no action needed, or note any minor item to monitor before PROD release.

   QA-TARGETING releases (Deployment Stage = "QA Environment" or "QA In Progress"):
   - These releases are NOT yet approaching PROD — do NOT prompt stakeholders for release decisions.
   - Instead, close with a brief forward-looking statement about what needs to happen before a PROD decision becomes relevant.
   - Examples:
     • "Once QA testing is underway and pass rates are established, a clearer picture of PROD readiness will emerge."
     • "The focus at this stage is on entering QA successfully — no stakeholder release decision is needed yet."
     • "Watch for QA results over the coming days; that data will drive the next release decision point."
   - If there are High/Critical/On-Hold items even at this stage, note them as risks to the upcoming QA cycle — not as PROD blockers.

INSIGHT QUALITY RULES:
• Must answer: "Can we release to the target environment?" and "What's the risk if we do?"
• Do NOT repeat the confidence percentage in the insight text
• Do NOT use section labels like "BUSINESS IMPACT:", "ROOT CAUSE:", "RECOMMENDED ACTION:", "DEPLOYMENT CONTEXT:", "TREND CONTEXT:"
• Write naturally — weave all points into flowing narrative prose
• The trend (up/down/flat) must feel like part of the story, not a data readout
• Must be actionable by PO/Stakeholder (not technical tasks for Engineering/QA)
• Every statement must be grounded in the provided data
• Never mention individual ticket IDs — speak in terms of counts and patterns
• Avoid technical jargon: no "refactoring", "technical debt", "deployment pipeline", "CI/CD"
• Avoid blame language: no "QA is behind", "Dev missed deadline", "team is struggling"

GOOD INSIGHT EXAMPLES:
• [QA Environment, Go, trend up] "This release is heading to the QA environment, so QA pass rate is not yet a factor. Signals have strengthened over the past week with no High, Critical, or On-Hold items — a positive indicator heading into QA testing. Once QA results begin coming in, they will provide the first clear signal toward PROD readiness. No stakeholder release decision is needed at this stage."
• [PROD Candidate, Watch, trend down] "QA validation is complete, making this a PROD deployment candidate — but confidence has slipped over the past week, which warrants attention before committing to a release date. Two High severity items and one On-Hold item introduce risk that customer-facing functionality could be affected post-release. Stakeholders should determine this week whether these items must be resolved before the PROD release or can be formally deferred — that decision directly controls whether this release ships on schedule."
• [QA In Progress, No-Go, trend down] "QA testing has not yet begun despite items being queued in the QA environment, and a declining trend over the past week suggests conditions are worsening rather than stabilizing. Two Critical severity items introduce risk that the upcoming QA cycle may be unstable. There is no PROD release decision needed yet, but stakeholders should be aware that unresolved Critical items at this stage could delay QA completion and push out the eventual PROD window."
• [QA → PROD, No-Go, trend flat] "With QA partially complete, this release is approaching but has not yet reached PROD readiness. One Critical item and two High severity items present a significant risk of customer-facing impact if released to PROD in its current state. Stakeholders need to decide whether to hold the PROD release date to allow these items to be resolved, or formally descope them to unblock the release — leaving this unresolved risks both schedule and quality outcomes."

BAD EXAMPLES (DO NOT DO):
• "Confidence is 90%..." — never repeat the percentage
• "Week-over-Week: improving" — never use trend as a label
• "7-day trend is up..." — never surface trend as a data readout
• "BUSINESS IMPACT: Cannot release..." — never use labels
• "RECOMMENDED ACTION: PO to..." — never use labels
• "QA Pass Rate is 0% which is concerning..." — instead explain WHY it is 0% using the interpretation rules
• "Stakeholders need to decide whether to release..." — for QA-targeting releases, no release decision is needed yet
• "Team is working hard" — stakeholders assume this
• "Engineering needs to fix bugs" — too vague
• "QA is behind schedule" — blame language
• "The deployment pipeline has issues" — technical jargon

4) Top Blockers (CONDITIONAL):
ONLY include this section if at least one release has Top Blockers data.
If no releases have blockers, skip this section entirely.

Create an HTML table with columns: Project | Release | Top Blockers
- Only display releases with Top Blockers
- CRITICAL: Preserve the exact format from the data: "Type ID - Title" (e.g., "Bug 45678 - Database error")
- If a release has multiple blockers, display each as a bullet list using <ul> and <li> tags
- Only include releases that have blocker data

OUTPUT FORMATTING:
- Use HTML formatting throughout: <h2>, <h3>, <table>, <p>, <br>
- Tables must have proper structure with <thead> and <tbody>
- Add spacing between sections using <br> tags
- Ensure email-ready HTML formatting
- Ensure the HTML renders cleanly in standard email clients (Outlook, Gmail)
- Do NOT use CSS classes — use only inline styles`;

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
    (details.added / Math.max(details.baseline, 1)) * 100,
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
    (r) => r.metrics.overallScore?.value >= 80,
  ).length;
  const atRisk = releasesData.filter(
    (r) =>
      r.metrics.overallScore?.value >= 60 && r.metrics.overallScore?.value < 80,
  ).length;
  const critical = releasesData.filter(
    (r) => r.metrics.overallScore?.value < 60,
  ).length;

  // Helper to accumulate token usage
  const usageTotals = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  const addUsage = (usage) => {
    if (!usage) return;
    usageTotals.prompt_tokens += usage.prompt_tokens || 0;
    usageTotals.completion_tokens += usage.completion_tokens || 0;
    usageTotals.total_tokens += usage.total_tokens || 0;
  };

  // Get individual summaries concurrently
  const summaryResults = await Promise.allSettled(
    releasesData.map(async (releaseData) => {
      const summary = await generateReleaseSummary(releaseData);
      return {
        release: releaseData.release,
        health: releaseData.metrics.overallScore?.value || 0,
        status: releaseData.metrics.overallScore?.status || 'unknown',
        summary,
      };
    }),
  );

  const summaries = [];
  const warnings = [];

  summaryResults.forEach((result, idx) => {
    const releaseName = releasesData[idx]?.release;

    if (result.status === 'fulfilled') {
      const { release, health, status, summary } = result.value;
      if (summary.ok) {
        summaries.push({
          release,
          health,
          status,
          summary: summary.content,
        });
        addUsage(summary.usage);
      } else {
        warnings.push(
          `Skipped ${release || releaseName}: ${summary.error || 'LLM error'}`,
        );
      }
    } else {
      warnings.push(
        `Skipped ${releaseName}: ${result.reason?.message || result.reason}`,
      );
    }
  });

  // Build prompt for portfolio risks
  const structuredReleaseLines = releasesData
    .map((r) => {
      const m = r.metrics || {};
      const d = r.details || {};
      const warningText =
        (r.warnings && r.warnings.length > 0
          ? r.warnings.join('; ')
          : 'None') || 'None';
      const trendText = r.trends?.velocity || 'n/a';

      return `Release: ${r.release}
- Health: ${m.overallScore?.value ?? 'n/a'} (${m.overallScore?.status ?? 'unknown'})
- Confidence: ${m.confidence?.value ?? 'n/a'} | QA: ${m.qaPct?.value ?? 'n/a'}% | Scope Stability: ${m.scopeStability?.value ?? 'n/a'}% | Predictability: ${m.predictability?.value ?? 'n/a'}%
- Blocked: ${d.blocked ?? 'n/a'} of ${d.active ?? 'n/a'} items (${m.blockedPct?.value ?? 'n/a'}%)
- Remaining items: ${d.remaining ?? 'n/a'}, ETA (days): ${m.etaDays?.value ?? 'n/a'}
- Trends: Velocity ${trendText}
- Warnings: ${warningText}`;
    })
    .join('\n\n');

  const portfolioPrompt = `You are a portfolio manager analyzing risks across multiple software releases.
Use ONLY the provided metrics—do not invent numbers or statuses.

Data (one block per release):
${structuredReleaseLines}

Output:
1) Top 3 portfolio-wide risks (cross-cutting themes, not per-release minutiae).
2) For each risk: actionable recommendation and accountable owner.
3) Keep it concise and reference the concrete metrics above when justifying each risk.`;

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
  if (portfolioRisks.ok) addUsage(portfolioRisks.usage);
  else
    warnings.push(
      `Portfolio risks generation failed: ${
        portfolioRisks.error || 'LLM error'
      }`,
    );

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
    warnings,
    usage: usageTotals,
  };
}

/**
 * Generate on-demand insight for Quality + Velocity metrics
 */
async function generateMetricsInsight(context) {
  const {
    release,
    qualitySummary,
    qualityWeekly = [],
    velocitySummary,
    velocityWeekly = [],
    dateRange,
  } = context;

  const qualityLines = qualityWeekly
    .map(
      (w) =>
        `Week ${formatWeekLabel(w.week)}: found=${w.bugs_found}, closed=${w.bugs_closed}, reopened=${w.reopened_bugs || 0}, median_resolution_days=${coalesce(
          w.median_resolution_days,
          'n/a',
        )}`,
    )
    .join('\n');

  const velocityLines = velocityWeekly
    .map(
      (w) =>
        `Week ${formatWeekLabel(w.week)}: closed=${w.closed_count}, effort=${w.closed_effort}, median_cycle_days=${coalesce(
          w.median_cycle_days,
          'n/a',
        )}, rework=${w.rework_count || 0}, scope_added=${w.scope_added || 0}, rolling_avg_3week=${coalesce(
          w.rolling_avg_3week,
          'n/a',
        )}`,
    )
    .join('\n');

  const prompt = `
Context:
- Release: ${release}
- Date Range: ${dateRange?.from || 'n/a'} to ${dateRange?.to || 'n/a'} (weekly buckets)

Quality Metrics (last 12 weeks):
- Critical Open: ${qualitySummary?.criticalOpen ?? 'n/a'}
- Reopen Rate: ${qualitySummary?.reopenRatePct ?? 'n/a'}% (${qualitySummary?.totalReopened ?? 0} reopened of ${qualitySummary?.totalClosed ?? 0} closed)
- Total Closed: ${qualitySummary?.totalClosed ?? 'n/a'}
- Weekly Bugs Found/Closed:
${qualityLines || 'n/a'}

Velocity Metrics (last 12 weeks):
- Avg Closed/Week: ${velocitySummary?.avgClosedPerWeek ?? 'n/a'}
- Last Week Closed: ${velocitySummary?.lastWeekClosed ?? 'n/a'}
- Total Closed: ${velocitySummary?.totalClosed ?? 'n/a'}
- Weeks Tracked: ${velocitySummary?.weeksTracked ?? 'n/a'}
- Weekly Throughput:
${velocityLines || 'n/a'}

What to do:
1) Give a short insight on quality trends (1–2 sentences), citing specific numbers.
2) Give a short insight on velocity/throughput (1–2 sentences), citing specific numbers.
3) If issues exist, list 1–3 concrete next actions with owner and expected effect. If data is thin, say “Data thin: …” and stop.
4) Keep it under 180 words. Use bullets for actions.
`;

  const messages = [
    {
      role: 'system',
      content:
        'You are a pragmatic software delivery coach. Provide concise, evidence-based insights on quality and velocity. Reference only the data given. If data is missing or thin, say so and limit your conclusions. Offer next steps with clear owners (e.g., QA Lead, Eng Manager, PO).',
    },
    { role: 'user', content: prompt },
  ];

  return await callOpenAI(messages, { max_tokens: 240, temperature: 0.3 });
}

function formatWeekLabel(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function coalesce(v, fallback) {
  return v === null || v === undefined ? fallback : v;
}

module.exports = {
  callOpenAI,
  generateReleaseSummary,
  generateRiskAnalysis,
  generateExecutiveReport,
  generateReleaseRadarReport,
  generateMetricsInsight,
};
