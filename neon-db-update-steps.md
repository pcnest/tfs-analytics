# Step-by-Step: Update Neon DB for Top Blockers Enhancement

## Prerequisites

- Access to Neon Console: https://console.neon.tech
- Your database connection ready
- Backup recommended (views can be recreated, but good practice)

---

## Step 1: Log into Neon Console

1. Go to https://console.neon.tech
2. Select your project
3. Navigate to **SQL Editor** (left sidebar)

---

## Step 2: Backup Current Views (Optional but Recommended)

Copy and save the current view definitions in case you need to rollback:

```sql
-- Save these results somewhere safe
SELECT pg_get_viewdef('v_release_health', true);
SELECT pg_get_viewdef('v_release_health_api', true);
```

---

## Step 3: Drop Existing Views (Required)

Since we're adding a column in the middle of the column list, we must drop and recreate the views. Copy and paste this into the Neon SQL Editor and execute:

```sql
-- Drop dependent view first
DROP VIEW IF EXISTS v_release_health_api;

-- Drop main view
DROP VIEW IF EXISTS v_release_health;
```

**Note:** Don't worry - we're recreating them immediately in Step 4.

---

## Step 4: Create Updated v_release_health View

Copy and paste this **entire SQL block** into the Neon SQL Editor and execute:

```sql
CREATE VIEW v_release_health AS
WITH
  base AS (
    SELECT
      COALESCE(
        NULLIF(tfs_workitems_analytics.project, ''::text),
        split_part(
          COALESCE(tfs_workitems_analytics.area_path, ''::text),
          '\'::text,
          1
        )
      ) AS project,
      COALESCE(
        NULLIF(
          TRIM(
            BOTH
            FROM
              tfs_workitems_analytics.release
          ),
          ''::text
        ),
        '(no release)'::text
      ) AS release,
      tfs_workitems_analytics.work_item_id,
      tfs_workitems_analytics.title,
      tfs_workitems_analytics.changed_date,
      upper(COALESCE(tfs_workitems_analytics.type, ''::text)) AS type_up,
      upper(COALESCE(tfs_workitems_analytics.state, ''::text)) AS state_up,
      upper(
        COALESCE(tfs_workitems_analytics.severity, ''::text)
      ) AS sev_up,
      lower(COALESCE(tfs_workitems_analytics.tags, ''::text)) AS tags_low
    FROM
      tfs_workitems_analytics
  ),
  qa AS (
    SELECT
      base.project,
      base.release,
      count(*) FILTER (
        WHERE
          base.state_up = ANY (
            ARRAY[
              'DONE'::text,
              'RESOLVED'::text,
              'READY FOR QA'::text,
              'QA TESTING'::text
            ]
          )
      ) AS qa_total,
      count(*) FILTER (
        WHERE
          base.state_up = 'DONE'::text
      ) AS qa_pass
    FROM
      base
    GROUP BY
      base.project,
      base.release
  ),
  open_bugs AS (
    SELECT
      base.project,
      base.release,
      base.work_item_id,
      base.type_up,
      base.title,
      base.tags_low,
      base.changed_date,
      CASE
        WHEN base.sev_up ~~ '%CRIT%'::text
        OR base.sev_up ~~ '1%'::text THEN 'Critical'::text
        WHEN base.sev_up ~~ '%HIGH%'::text
        OR base.sev_up ~~ '2%'::text THEN 'High'::text
        WHEN base.sev_up ~~ '%MED%'::text
        OR base.sev_up ~~ '3%'::text THEN 'Medium'::text
        ELSE 'Low'::text
      END AS sev_band
    FROM
      base
    WHERE
      base.type_up = 'BUG'::text
      AND base.state_up <> 'DONE'::text
  ),
  bug_counts AS (
    SELECT
      open_bugs.project,
      open_bugs.release,
      count(*) FILTER (
        WHERE
          open_bugs.sev_band = 'Critical'::text
      ) AS critical,
      count(*) FILTER (
        WHERE
          open_bugs.sev_band = 'High'::text
      ) AS high,
      count(*) FILTER (
        WHERE
          open_bugs.sev_band = 'Medium'::text
      ) AS medium,
      count(*) FILTER (
        WHERE
          open_bugs.sev_band = 'Low'::text
      ) AS low
    FROM
      open_bugs
    GROUP BY
      open_bugs.project,
      open_bugs.release
  ),
  on_hold AS (
    SELECT
      base.project,
      base.release,
      count(*) AS on_hold
    FROM
      base
    WHERE
      base.state_up = 'ON-HOLD'::text
    GROUP BY
      base.project,
      base.release
  ),
  blockers AS (
    SELECT
      x.project,
      x.release,
      -- NEW: Format as "Type ID - Title"
      string_agg(
        x.type_up || ' ' || x.work_item_id::text || ' - ' || x.title,
        ' | '::text
        ORDER BY
          x.changed_date DESC
      ) AS top_blockers,
      -- NEW: Separate pipe-delimited IDs for frontend parsing
      string_agg(
        x.work_item_id::text,
        '|'::text
        ORDER BY
          x.changed_date DESC
      ) AS top_blocker_ids
    FROM
      (
        SELECT
          open_bugs.project,
          open_bugs.release,
          open_bugs.work_item_id,
          open_bugs.type_up,
          open_bugs.title,
          open_bugs.changed_date,
          row_number() OVER (
            PARTITION BY
              open_bugs.project,
              open_bugs.release
            ORDER BY
              open_bugs.changed_date DESC
          ) AS rn
        FROM
          open_bugs
        WHERE
          open_bugs.sev_band = 'Critical'::text
          OR open_bugs.tags_low ~~ '%blocker%'::text
      ) x
    WHERE
      x.rn <= 5
    GROUP BY
      x.project,
      x.release
  ),
  joined AS (
    SELECT
      COALESCE(bc.project, qa.project, oh.project) AS project,
      COALESCE(bc.release, qa.release, oh.release) AS release,
      COALESCE(bc.critical, 0::bigint)::integer AS "Critical",
      COALESCE(bc.high, 0::bigint)::integer AS "High",
      COALESCE(bc.medium, 0::bigint)::integer AS "Medium",
      COALESCE(bc.low, 0::bigint)::integer AS "Low",
      COALESCE(oh.on_hold, 0::bigint)::integer AS "OnHold",
      COALESCE(qa.qa_pass, 0::bigint)::integer AS "QAPass",
      COALESCE(qa.qa_total, 0::bigint)::integer AS "QATotal",
      blk.top_blockers AS "Top Blockers",
      blk.top_blocker_ids AS "Top Blocker IDs"
    FROM
      bug_counts bc
      FULL JOIN qa ON qa.project = bc.project
      AND qa.release = bc.release
      FULL JOIN on_hold oh ON oh.project = COALESCE(bc.project, qa.project)
      AND oh.release = COALESCE(bc.release, qa.release)
      LEFT JOIN blockers blk ON blk.project = COALESCE(bc.project, qa.project, oh.project)
      AND blk.release = COALESCE(bc.release, qa.release, oh.release)
  ),
  scored AS (
    SELECT
      j.project,
      j.release,
      j."Critical",
      j."High",
      j."Medium",
      j."Low",
      j."OnHold",
      j."QAPass",
      j."QATotal",
      j."Top Blockers",
      j."Top Blocker IDs",
      CASE
        WHEN j."QATotal" = 0 THEN NULL::text
        ELSE (j."QAPass"::text || '/'::text) || j."QATotal"::text
      END AS "QA status (pass/total)",
      CASE
        WHEN j."QATotal" = 0 THEN NULL::integer
        ELSE round(
          100.0 * j."QAPass"::numeric / j."QATotal"::numeric
        )::integer
      END AS "QA%",
      LEAST(
        100,
        GREATEST(
          0,
          round(
            (
              100 - (
                j."Critical" * 30 + j."High" * 10 + j."OnHold" * 15
              )
            )::double precision
          )::integer
        )
      ) AS "ConfidencePct",
      j."Critical" * 30 AS crit_loss,
      j."High" * 10 AS high_loss,
      j."OnHold" * 15 AS hold_loss
    FROM
      joined j
  )
SELECT
  project,
  release,
  "ConfidencePct",
  CASE
    WHEN ("Critical" + "High" + "OnHold") = 0 THEN 'No High/Critical/OnHold'::text
    ELSE concat_ws(
      ', '::text,
      CASE
        WHEN "Critical" > 0 THEN "Critical"::text || ' Critical'::text
        ELSE NULL::text
      END,
      CASE
        WHEN "High" > 0 THEN "High"::text || ' High'::text
        ELSE NULL::text
      END,
      CASE
        WHEN "OnHold" > 0 THEN "OnHold"::text || ' OnHold'::text
        ELSE NULL::text
      END
    )
  END || CASE
    WHEN "QA%" IS NULL THEN ''::text
    ELSE (' | '::text || "QA%"::text) || '% QA'::text
  END AS "Confidence Signals",
  (
    WITH
      mx AS (
        SELECT
          GREATEST(s.crit_loss, s.high_loss, s.hold_loss) AS max_loss
      )
    SELECT
      CASE
        WHEN (
          (
            SELECT
              mx.max_loss
            FROM
              mx
          )
        ) = 0 THEN 'None'::text
        ELSE CASE
          WHEN cardinality(d.drivers) = 1 THEN d.drivers[1] || '-driven'::text
          ELSE array_to_string(d.drivers, ' + '::text) || '-driven'::text
        END
      END AS "case"
    FROM
      (
        SELECT
          array_remove(
            ARRAY[
              CASE
                WHEN s.crit_loss > 0
                AND s.crit_loss >= (
                  (
                    (
                      SELECT
                        mx.max_loss
                      FROM
                        mx
                    )
                  ) - 5
                ) THEN 'Critical'::text
                ELSE NULL::text
              END,
              CASE
                WHEN s.high_loss > 0
                AND s.high_loss >= (
                  (
                    (
                      SELECT
                        mx.max_loss
                      FROM
                        mx
                    )
                  ) - 5
                ) THEN 'High'::text
                ELSE NULL::text
              END,
              CASE
                WHEN s.hold_loss > 0
                AND s.hold_loss >= (
                  (
                    (
                      SELECT
                        mx.max_loss
                      FROM
                        mx
                    )
                  ) - 5
                ) THEN 'On-Hold'::text
                ELSE NULL::text
              END
            ],
            NULL::text
          ) AS drivers
      ) d
  ) AS "Confidence Driver",
  "Critical",
  "High",
  "Medium",
  "Low",
  "OnHold",
  "QAPass",
  "QATotal",
  "QA status (pass/total)",
  "QA%",
  "Top Blockers",
  "Top Blocker IDs",
  CASE
    WHEN "ConfidencePct" < 80
    OR "OnHold" > 0 THEN 'Y'::text
    ELSE ''::text
  END AS "Decision Needed (Y/N)"
FROM
  scored s;
```

**What changed:**

- Added `work_item_id` and `type_up` to `open_bugs` CTE
- Updated `blockers` CTE to format as `"Type ID - Title"` (e.g., "BUG 12345 - Database timeout")
- Added `top_blocker_ids` column with pipe-delimited IDs
- Changed limit from 3 to 5 blockers
- Added `"Top Blocker IDs"` to `joined` and `scored` CTEs
- Added `"Top Blocker IDs"` to final SELECT

---

## Step 5: Verify v_release_health Creation

Run this query to verify the view was created successfully:

```sql
SELECT
  project,
  release,
  "Top Blockers",
  "Top Blocker IDs"
FROM v_release_health
WHERE "Top Blockers" IS NOT NULL
LIMIT 5;
```

**Expected output format:**

```
Top Blockers: "BUG 12345 - Database timeout | BUG 67890 - Memory leak"
Top Blocker IDs: "12345|67890"
```

---

## Step 6: Create Updated v_release_health_api View

Copy and paste this SQL into the Neon SQL Editor and execute:

```sql
CREATE VIEW v_release_health_api AS
SELECT
  project,
  release,
  "ConfidencePct" AS confidence_pct,
  "Confidence Signals" AS confidence_signals,
  "Confidence Driver" AS confidence_driver,
  "Critical" AS critical,
  "High" AS high,
  "Medium" AS medium,
  "Low" AS low,
  "OnHold" AS on_hold,
  "QAPass" AS qa_pass,
  "QATotal" AS qa_total,
  "QA status (pass/total)" AS qa_status,
  "QA%" AS qa_pct,
  "Top Blockers" AS top_blockers,
  "Top Blocker IDs" AS top_blocker_ids,
  "Decision Needed (Y/N)" AS decision_needed
FROM
  v_release_health;
```

**What changed:**

- Added `"Top Blocker IDs" AS top_blocker_ids` line

---

## Step 7: Verify v_release_health_api Creation

Run this query:

```sql
SELECT
  project,
  release,
  top_blockers,
  top_blocker_ids
FROM v_release_health_api
WHERE top_blockers IS NOT NULL
LIMIT 5;
```

**Expected:** Same data as Step 5, but with lowercase column names.

---

## Step 8: Test the Complete Integration

Run this comprehensive test:

```sql
SELECT
  project,
  release,
  confidence_pct,
  critical,
  on_hold,
  top_blockers,
  top_blocker_ids,
  decision_needed
FROM v_release_health_api
ORDER BY confidence_pct ASC
LIMIT 10;
```

**What to look for:**

- ✅ `top_blockers` shows format: `"BUG 12345 - Title | TASK 67890 - Title"`
- ✅ `top_blocker_ids` shows format: `"12345|67890"`
- ✅ No NULL errors
- ✅ Data looks reasonable

---

## Step 9: Restart Your Node.js Application

The frontend code is already updated, so just restart the server:

```powershell
# In your PowerShell terminal
# Stop the server (Ctrl+C if running)
npm start
```

---

## Step 10: Verify in UI

1. Open browser: http://localhost:3000
2. Load the Release Radar section
3. Check the "Top Blockers" column

**Expected:**

```
• BUG 12345 — Database timeout
• TASK 67890 — API refactoring
```

Work item IDs should be clickable and navigate to TFS/Azure DevOps.

---

## Troubleshooting

### Issue: "column does not exist"

**Cause:** View update didn't complete successfully

**Solution:**

```sql
-- Check if view has the new column
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'v_release_health'
AND column_name LIKE '%Blocker%';

-- Should return: "Top Blockers" and "Top Blocker IDs"
```

### Issue: "Top Blockers" is NULL

**Cause:** No critical bugs or blocker-tagged items in your data

**Solution:**

```sql
-- Check if you have any critical bugs
SELECT COUNT(*)
FROM tfs_workitems_analytics
WHERE upper(type) = 'BUG'
  AND upper(state) <> 'DONE'
  AND (upper(severity) LIKE '%CRIT%' OR lower(tags) LIKE '%blocker%');

-- If count is 0, you have no blockers (which is good!)
```

### Issue: Format doesn't match "Type ID - Title"

**Cause:** Data might have unexpected characters

**Solution:**

```sql
-- Check raw data
SELECT
  work_item_id,
  type,
  title,
  upper(type) || ' ' || work_item_id::text || ' - ' || title as formatted
FROM tfs_workitems_analytics
WHERE upper(type) = 'BUG'
  AND upper(state) <> 'DONE'
  AND upper(severity) LIKE '%CRIT%'
LIMIT 5;
```

### Issue: Links not working in UI

**Cause:** TFS_WORKITEM_URL_TEMPLATE not set

**Solution:**

```powershell
# In your .env file or environment
$env:TFS_WORKITEM_URL_TEMPLATE="https://dev.azure.com/yourorg/yourproject/_workitems/edit/{id}"
npm start
```

---

## Rollback (If Needed)

If something goes wrong, you can restore the old views:

```sql
-- 1. Drop the updated views
DROP VIEW IF EXISTS v_release_health_api;
DROP VIEW IF EXISTS v_release_health;

-- 2. Recreate using your backup from Step 2
-- Paste the saved view definitions here
```

---

## Success Checklist

- [ ] Step 3: Existing views dropped successfully
- [ ] Step 4: v_release_health view created successfully
- [ ] Step 5: View returns data with new format
- [ ] Step 6: v_release_health_api view created successfully
- [ ] Step 7: API view returns data with new columns
- [ ] Step 8: Comprehensive test passes
- [ ] Step 9: Node.js server restarted
- [ ] Step 10: UI shows formatted blockers with clickable links

---

## Next Steps After Success

1. **Monitor performance** - The updated view should perform similarly to before
2. **Check other releases** - Verify format works across different releases
3. **Test CSV export** - Ensure both columns are included
4. **Test AI report generation** - Verify it uses the new format

---

## Key Changes Summary

| Component              | Change                                              |
| ---------------------- | --------------------------------------------------- |
| `open_bugs` CTE        | Added `work_item_id` and `type_up` columns          |
| `blockers` CTE         | Changed format from `title` to `"Type ID - Title"`  |
| `blockers` CTE         | Added `top_blocker_ids` column (pipe-delimited IDs) |
| `blockers` CTE         | Increased limit from 3 to 5 blockers                |
| `joined` CTE           | Added `"Top Blocker IDs"` column                    |
| `scored` CTE           | Passed through `"Top Blocker IDs"` column           |
| Final SELECT           | Added `"Top Blocker IDs"` to output                 |
| `v_release_health_api` | Added `top_blocker_ids` column mapping              |

---

**Estimated time:** 5-10 minutes

**Questions?** Check the troubleshooting section or review the documentation files:

- `TOP_BLOCKERS_UPDATE.md` - Detailed implementation guide
- `IMPLEMENTATION_CHANGES.md` - Technical changes summary
- `test-queries.sql` - Additional validation queries
