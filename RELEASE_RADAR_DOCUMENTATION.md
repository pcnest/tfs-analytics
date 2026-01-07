# Release Radar Documentation

## Overview

**Release Radar** (also called **Release Health**) is an executive dashboard that provides a comprehensive, at-a-glance view of release readiness across multiple software projects. It consolidates key metrics that answer the critical question: _"Is this release on track, or does it need intervention?"_

The Release Radar is designed for stakeholders who need to quickly assess portfolio health, identify risks, and make data-driven decisions about release timing and resource allocation.

---

## Core Metrics

### 1. **Confidence** (Confidence %)

**Definition:** A composite score (0-100%) that represents overall confidence in the release's ability to ship on time with acceptable quality.

**How it's computed:**

- Derived from a weighted combination of multiple health signals including:
  - Scope stability (low churn = higher confidence)
  - QA pass rate (higher pass rate = higher confidence)
  - Blocked work items (fewer blocked items = higher confidence)
  - Critical/high priority bugs (fewer critical bugs = higher confidence)
  - Historical velocity trends (consistent delivery = higher confidence)

**Interpretation:**

- **80-100%** (🟢 Green): High confidence - release is on track
- **60-79%** (🟡 Yellow): Medium confidence - some concerns, monitor closely
- **0-59%** (🔴 Red): Low confidence - significant risks, intervention needed

**Relevance:**
The Confidence score is the **primary health indicator** for executives. It synthesizes complex project data into a single, actionable metric. A declining confidence score should trigger stakeholder conversations and mitigation planning.

---

### 2. **QA (Quality Assurance)**

**Definition:** Shows the QA testing coverage and pass rate for the release.

**How it's computed:**

- **QA Status Format:** `pass/total (percentage)`
  - Example: `42/50 (84%)` means 42 items passed QA out of 50 total items requiring QA
- **QA Pass (QAPass):** Count of work items that have passed QA testing
- **QA Total (QATotal):** Total count of work items that require QA testing
- **QA% (qaPct):** `(QAPass / QATotal) * 100`

**Data Sources:**

- Work items in states like "Ready for QA", "QA Testing", "QA Passed"
- Test results linked to work items
- May include automated test pass rates

**Interpretation:**

- **High QA% (>80%):** Most items have been validated - good quality signal
- **Medium QA% (60-80%):** Quality validation in progress - normal for mid-release
- **Low QA% (<60%):** Limited testing coverage - potential quality risk

**Relevance:**
QA metrics predict **post-release stability**. Low QA pass rates late in a release cycle indicate either quality issues that need fixing or insufficient testing bandwidth. This metric helps answer: _"Are we confident this release won't cause production incidents?"_

---

### 3. **C/H/M/L (Critical/High/Medium/Low)**

**Definition:** Priority breakdown showing the count of open work items by severity/priority level.

**How it's computed:**

- **Critical:** `COUNT(*) WHERE severity='Critical' OR priority='1' AND state NOT IN ('Done','Removed')`
- **High:** `COUNT(*) WHERE severity='High' OR priority='2' AND state NOT IN ('Done','Removed')`
- **Medium:** `COUNT(*) WHERE severity='Medium' OR priority='3' AND state NOT IN ('Done','Removed')`
- **Low:** `COUNT(*) WHERE severity='Low' OR priority='4' AND state NOT IN ('Done','Removed')`

**Display Format:** `C/H/M/L` (e.g., `2/5/12/8` means 2 Critical, 5 High, 12 Medium, 8 Low items)

**Interpretation:**

- **Critical > 0:** Urgent attention needed - potential blockers to release
- **High > 5:** Significant work remaining - may impact timelines
- **Medium/Low backlog:** Normal technical debt, can often be deferred

**Relevance:**
This metric provides **scope and risk visibility**. Critical and High items directly impact release decisions. A release with 10 open Critical bugs should not ship, while one with 10 Low priority items might be acceptable. This data informs **go/no-go decisions**.

---

### 4. **OnHold**

**Definition:** Count of work items that are currently blocked or on hold.

**How it's computed:**

- `COUNT(*) WHERE state='On Hold' OR reason='Blocked' OR open_dep_count > 0`
- Includes items explicitly marked as blocked
- Includes items with unresolved dependencies

**Interpretation:**

- **OnHold = 0:** No blockers - healthy flow
- **OnHold > 0, < 10% of scope:** Minor blockers, manageable
- **OnHold > 10% of scope:** Significant workflow impediment - requires intervention

**Relevance:**
OnHold items represent **velocity risk**. Blocked work doesn't progress, and blockers often have cascading effects on dependent work. High OnHold counts indicate process issues, external dependencies, or architectural bottlenecks that need immediate escalation.

---

### 5. **Driver (Confidence Driver)**

**Definition:** A text summary identifying the **primary factor** influencing the Confidence score.

**How it's computed:**

- Algorithmic analysis of which metrics have the most impact on confidence
- Examples:
  - `"High-driven"` - Many High priority items driving confidence down
  - `"On-Hold-driven"` - Blocked items are the main concern
  - `"Critical-driven"` - Critical bugs are the primary risk
  - `"QA-driven"` - QA coverage or pass rate is the limiting factor

**Typical Logic:**

```javascript
if (critical > 2) return "Critical-driven";
if (onHold > 10% scope) return "On-Hold-driven";
if (qaPct < 50) return "QA-driven";
if (high > 10) return "High-driven";
return "None" or "Balanced";
```

**Relevance:**
The Driver provides **root cause context** for the Confidence score. Instead of just seeing "Confidence: 45%", stakeholders see "Confidence: 45% (Critical-driven)" and immediately know to focus on resolving critical bugs. This enables **targeted intervention** rather than general concern.

---

### 6. **Signals (Confidence Signals)**

**Definition:** A summary of contributing factors and trends that inform the Confidence score.

**How it's computed:**

- Multi-factor assessment combining:
  - **Scope signals:** `"5 OnHold | 99% QA"` (5 blocked items, 99% QA coverage)
  - **Priority signals:** `"1 High, 4 OnHold"` (breakdown of open priorities)
  - **Trend signals:** `"2 High, 1 OnHold | 98% QA"` (current state across dimensions)

**Format:** Pipe-separated metrics showing the most relevant signals

- Example: `"2 High, 1 OnHold | 98% QA"` indicates 2 High priority items, 1 blocked item, and 98% QA pass rate

**Relevance:**
Signals provide **nuanced detail** beyond the single Confidence number. They help stakeholders understand _why_ confidence is at a certain level and _what's trending_. For example, high QA pass rate signals quality readiness even if scope is incomplete.

---

### 7. **Top Blockers**

**Definition:** A list of the most impactful work items currently blocking progress.

**How it's computed:**

- Query identifies work items with:
  - State = "On Hold" OR
  - High `open_dep_count` (many items depend on this) OR
  - Severity = "Critical" AND state NOT IN ('Done','Removed')
- Ranked by:
  1. Number of dependent items (blocker impact)
  2. Severity/Priority
  3. Age (how long blocked)
- Top 3-5 items displayed

**Display Format:**

- **Standard format:** `<Type> <ID> - <Title>`
  - Example: `Bug 12345 - Database connection timeout`
  - Example: `Task 67890 - API endpoint refactoring`
- **Multiple blockers:** Displayed as a bulleted list
- **Clickable IDs:** Work item IDs are hyperlinked to TFS/Azure DevOps for direct access

**Relevance:**
Top Blockers enable **direct action**. Instead of abstract metrics, stakeholders see specific work items like "Bug 45678: Database migration failure" and can immediately assign resources, escalate to vendors, or adjust scope. This metric transforms data into **actionable tasks**.

---

### 8. **Decision Needed (Decision)**

**Definition:** A flag (Y/N) indicating whether executive/stakeholder decision-making is required.

**How it's computed:**

- Rule-based logic evaluates multiple conditions:

```javascript
Decision = 'Y' if ANY of:
  - Confidence < 60%
  - Critical bugs > 0 within 7 days of planned ship date
  - OnHold items > 15% of total scope
  - QA% < 50% within 14 days of planned ship date
  - Scope stability < 70% (high churn)
  - Custom business rules (e.g., regulatory blockers)
Otherwise Decision = 'N'
```

**Interpretation:**

- **Y (Yes):** Requires immediate stakeholder review - potential go/no-go decision needed
- **N (No):** On track, no special intervention required

**Relevance:**
Decision flags act as an **early warning system**. They ensure critical releases don't slip through the cracks and force proactive conversations before problems escalate. A "Y" decision triggers specific workflows:

- Schedule war room/checkpoint meeting
- Review scope reduction options
- Evaluate slip date vs. ship-with-known-issues tradeoffs
- Escalate to executive leadership

---

## Use Cases

### 1. **Weekly Executive Status Meeting**

Leadership reviews Release Radar to get portfolio-wide health in 5 minutes:

- "3 releases are green, 2 are yellow with QA-driven concerns, 1 is red (Critical-driven)"
- Focus discussion on red/yellow releases only

### 2. **Release Go/No-Go Decision**

Team uses Decision flag + Confidence + Top Blockers:

- Decision = Y → Detailed review
- Confidence < 70% → Consider slip
- Critical bugs > 0 → Evaluate severity
- Top Blockers reviewed → Mitigation plan created

### 3. **Resource Allocation**

PM sees multiple releases are "QA-driven" with low QA%:

- Reallocate QA resources from green releases to yellow ones
- Hire contract QA testers
- Automate more test coverage

### 4. **Trend Analysis**

Track Confidence scores week-over-week:

- Release 5.0: 85% → 82% → 78% (declining, investigate)
- Release 6.0: 65% → 72% → 80% (improving, keep current approach)

---

## Data Source

All Release Radar metrics are computed from the **`v_release_health`** database view, which aggregates data from:

- **`tfs_workitems_analytics`** - Core work item data (state, severity, priority, dependencies)
- **`tfs_workitems_analytics_snapshots`** - Historical snapshots for trend analysis
- **`tfs_sync_runs`** - Data freshness tracking

### Sample View Query Structure

```sql
CREATE OR REPLACE VIEW v_release_health AS
WITH release_metrics AS (
  -- Count by severity
  SELECT
    project,
    release,
    COUNT(*) FILTER (WHERE severity = 'Critical' AND state NOT IN ('Done','Removed')) AS "Critical",
    COUNT(*) FILTER (WHERE severity = 'High' AND state NOT IN ('Done','Removed')) AS "High",
    COUNT(*) FILTER (WHERE severity = 'Medium' AND state NOT IN ('Done','Removed')) AS "Medium",
    COUNT(*) FILTER (WHERE severity = 'Low' AND state NOT IN ('Done','Removed')) AS "Low",
    COUNT(*) FILTER (WHERE state = 'On Hold' OR open_dep_count > 0) AS "OnHold"
  FROM tfs_workitems_analytics
  WHERE is_deleted = FALSE
  GROUP BY project, release
),
qa_metrics AS (
  -- QA pass rate
  SELECT
    project,
    release,
    COUNT(*) FILTER (WHERE state = 'QA Passed') AS "QAPass",
    COUNT(*) FILTER (WHERE state IN ('QA Testing','QA Passed','Ready for QA')) AS "QATotal"
  FROM tfs_workitems_analytics
  WHERE is_deleted = FALSE
  GROUP BY project, release
),
confidence_calc AS (
  -- Compute confidence score
  SELECT
    rm.project,
    rm.release,
    -- Confidence formula (example - customize to your needs)
    GREATEST(0, LEAST(100,
      100 - (rm."Critical" * 20) - (rm."OnHold" * 5) + (qa."QAPass" / NULLIF(qa."QATotal", 0) * 20)
    )) AS "ConfidencePct"
  FROM release_metrics rm
  LEFT JOIN qa_metrics qa USING (project, release)
)
SELECT
  rm.project,
  rm.release,
  cc."ConfidencePct"::int,
  -- Driver logic
  CASE
    WHEN rm."Critical" > 0 THEN 'Critical-driven'
    WHEN rm."OnHold" > 5 THEN 'On-Hold-driven'
    WHEN qa."QATotal" > 0 AND (qa."QAPass"::float / qa."QATotal") < 0.5 THEN 'QA-driven'
    WHEN rm."High" > 10 THEN 'High-driven'
    ELSE 'None'
  END AS "Confidence Driver",
  -- Signals
  rm."Critical" || ' Critical, ' || rm."High" || ' High, ' || rm."OnHold" || ' OnHold | ' ||
    COALESCE(ROUND((qa."QAPass"::float / NULLIF(qa."QATotal", 0)) * 100), 0) || '% QA' AS "Confidence Signals",
  rm."Critical",
  rm."High",
  rm."Medium",
  rm."Low",
  rm."OnHold",
  qa."QAPass",
  qa."QATotal",
  qa."QAPass" || '/' || qa."QATotal" AS "QA status (pass/total)",
  COALESCE(ROUND((qa."QAPass"::float / NULLIF(qa."QATotal", 0)) * 100), 0) AS "QA%",
  -- Top Blockers (simplified - expand with actual query)
  'See detailed query' AS "Top Blockers",
  -- Decision flag
  CASE
    WHEN cc."ConfidencePct" < 60 THEN 'Y'
    WHEN rm."Critical" > 0 THEN 'Y'
    WHEN rm."OnHold" > 10 THEN 'Y'
    ELSE 'N'
  END AS "Decision Needed (Y/N)"
FROM release_metrics rm
LEFT JOIN qa_metrics qa USING (project, release)
LEFT JOIN confidence_calc cc USING (project, release)
WHERE rm.release IS NOT NULL AND rm.release != ''
ORDER BY rm.project, rm.release;
```

**Note:** The actual view must be created in your PostgreSQL database. Customize the confidence formula and decision logic to match your organization's release criteria.

---

## API Endpoints

### Get Release Health Data

```bash
GET /api/release-health
GET /api/release-health?project=Agent7&release=18.4
GET /api/release-health?includeNoRelease=1
```

**Response:**

```json
{
  "ok": true,
  "rows": [
    {
      "project": "Agent7",
      "release": "18.4",
      "confidencePct": 65,
      "confidenceDriver": "High + On-Hold-driven",
      "confidenceSignals": "2 High, 1 OnHold | 98% QA",
      "critical": 0,
      "high": 2,
      "medium": 12,
      "low": 8,
      "onHold": 1,
      "qaPass": 150,
      "qaTotal": 153,
      "qaStatus": "150/153",
      "qaPct": 98,
      "topBlockers": "ENT: Scheduler is Not Working",
      "decisionNeeded": "N"
    }
  ]
}
```

### Export Release Health as CSV

```bash
GET /api/release-health/export.csv
GET /api/release-health/export.csv?release=18.4
```

### Generate AI-Assisted Release Radar Report

```bash
POST /api/generate-release-radar-report
{
  "releases": ["18.4", "18.5", "80.1.6"]
}
```

Returns an executive summary with AI-generated insights, risk assessment, and recommendations.

---

## Best Practices

### 1. **Review Cadence**

- **Daily:** Engineering teams check Confidence + Top Blockers
- **Weekly:** Leadership reviews full Release Radar for all active releases
- **Pre-release:** Deep dive on Decision = Y releases

### 2. **Thresholds and Alerts**

Configure automated alerts:

- Confidence drops below 60%
- Critical bugs > 0 within 7 days of ship date
- OnHold items > 15% of scope
- Decision flag changes from N to Y

### 3. **Action Items**

When Release Radar shows issues:

1. **Identify root cause** using Driver + Signals
2. **Review Top Blockers** and assign owners
3. **Make decisions**: Slip date, reduce scope, add resources
4. **Document** decisions and track in subsequent reviews

### 4. **Continuous Improvement**

- **Retrospective:** After each release, review whether Confidence score accurately predicted outcomes
- **Tune formula:** Adjust confidence calculations based on historical accuracy
- **Refine thresholds:** Calibrate decision flags to minimize false positives/negatives

---

## Limitations & Considerations

1. **Data Freshness:** Release Radar is only as good as the underlying data. Stale work item updates lead to inaccurate metrics.

2. **Formula Subjectivity:** Confidence scores use weighted formulas that may not perfectly capture organizational risk tolerance. Tune these formulas based on your team's historical data.

3. **Manual Overrides:** Sometimes teams have context (e.g., "Those 3 Critical bugs are all in a deprecated feature we're removing") that isn't reflected in metrics. Provide a way to add manual notes/overrides.

4. **Cross-team Dependencies:** Top Blockers may include external dependencies (vendor APIs, infrastructure) that aren't tracked as work items.

5. **Quality vs. Quantity:** High QA% doesn't guarantee quality if tests are shallow. Supplement with test coverage metrics and production incident rates.

---

## Conclusion

Release Radar provides a **unified, data-driven view** of release health that enables:

- **Fast decision-making** for leadership
- **Proactive risk management** for engineering teams
- **Transparent communication** across stakeholders
- **Objective release readiness assessment**

By understanding what each metric represents and how it's computed, teams can use Release Radar to ship higher quality software, on time, with confidence.

---

## Related Documentation

- [PHASE1_MVP_IMPLEMENTATION.md](./PHASE1_MVP_IMPLEMENTATION.md) - Initial implementation details
- [AI_FEATURES_README.md](./AI_FEATURES_README.md) - AI-powered release insights
- [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md) - System architecture
- [README.md](./README.md) - Setup and usage instructions
