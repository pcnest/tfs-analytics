# Top Blockers Enhancement - Implementation Guide

## Overview

This update enhances the **Top Blockers** display in the Release Radar table to show work items in a more informative format with clickable links.

### New Format

```
<Type> <ID> - <Title>
```

**Example:**

```
Bug 12345 - Database connection timeout
Task 67890 - API endpoint refactoring
```

The work item IDs are clickable and navigate directly to TFS/Azure DevOps.

---

## Changes Made

### 1. SQL View Update

**File:** `create-v-release-health.sql`

The `v_release_health` view now includes enhanced logic to:

1. **Identify Top Blockers** - Ranks work items by impact:

   - Critical severity bugs (highest priority)
   - Items with state = 'On Hold'
   - Items with open dependencies (`open_dep_count > 0`)

2. **Format Output** - Creates two columns:

   - `"Top Blockers"`: Formatted text like `"Bug 12345 - Title | Task 67890 - Title"`
   - `"Top Blocker IDs"`: Pipe-separated IDs like `"12345|67890"`

3. **Limit to Top 5** - Shows only the 5 most critical blockers per release

**SQL Logic:**

```sql
top_blockers_data AS (
  SELECT
    project,
    release,
    STRING_AGG(
      type || ' ' || work_item_id || ' - ' || title,
      ' | '
      ORDER BY ranking, work_item_id
    ) FILTER (WHERE rn <= 5) AS "Top Blockers",
    STRING_AGG(
      work_item_id::text,
      '|'
      ORDER BY ranking, work_item_id
    ) FILTER (WHERE rn <= 5) AS "Top Blocker IDs"
  FROM (...)
)
```

### 2. Frontend Update

**File:** `public/app.js`

Updated the `formatBlockers()` function to:

1. **Parse the new format** - Extracts Type, ID, and Title from the formatted text
2. **Render clickable links** - Uses existing `renderIdPill()` to create TFS links
3. **Style appropriately** - Type in gray, ID as clickable pill, title in default color

**Before:**

```javascript
// Old: Simple text split
const items = texts.map((t) => `<li>${escapeHtml(t)}</li>`);
```

**After:**

```javascript
// New: Parse format and create clickable links
const match = blockerText.match(/^(\w+)\s+(\d+)\s+-\s+(.+)$/);
if (match && id) {
  const [, type, workItemId, title] = match;
  const pill = renderIdPill(id);
  items.push(
    `<li><span style="color:#666;">${escapeHtml(
      type
    )}</span> ${pill} — ${escapeHtml(title)}</li>`
  );
}
```

---

## Installation Steps

### Step 1: Update Database View

Run the SQL script in your Neon PostgreSQL database:

```bash
# Option 1: Via Neon SQL Editor (Web UI)
1. Log into Neon Console (https://console.neon.tech)
2. Navigate to your database
3. Open SQL Editor
4. Copy contents of create-v-release-health.sql
5. Execute the script
6. Verify with: SELECT * FROM v_release_health LIMIT 5;

# Option 2: Via psql command line
psql $DATABASE_URL -f create-v-release-health.sql
```

**Important:** This script uses `CREATE OR REPLACE VIEW`, so it's safe to run multiple times. Existing data is not affected.

### Step 2: Update Frontend Code

The frontend code (`public/app.js`) has already been updated. If you've deployed the app, restart the server to pick up the changes:

```powershell
# Stop the server (Ctrl+C if running)
# Restart
npm start
```

### Step 3: Verify

1. **Navigate to the dashboard**

   ```
   http://localhost:3000
   ```

2. **Check Release Radar table**

   - Look for the "Top Blockers" column
   - Verify format shows: `Type ID - Title`
   - Click on work item IDs to ensure links work

3. **Sample Output:**
   ```
   Top Blockers:
   • Bug 12345 — Database connection timeout
   • Task 67890 — API endpoint refactoring
   • Bug 11223 — Memory leak in scheduler
   ```

---

## Configuration

### Customize TFS URL Template

The work item links use the `TFS_WORKITEM_URL_TEMPLATE` environment variable:

```bash
# In your .env file or environment
TFS_WORKITEM_URL_TEMPLATE=https://your-tfs-server.com/_workitems/edit/{id}
```

**Example URLs:**

- **Azure DevOps:** `https://dev.azure.com/org/project/_workitems/edit/{id}`
- **TFS On-Premise:** `https://tfs.company.com/DefaultCollection/_workitems/edit/{id}`

### Customize Blocker Ranking

Edit the `ORDER BY` clause in `create-v-release-health.sql` to change prioritization:

```sql
ORDER BY
  CASE WHEN severity = 'Critical' THEN 1      -- Highest priority
       WHEN state = 'On Hold' THEN 2          -- Second priority
       WHEN open_dep_count > 0 THEN 3         -- Third priority
       ELSE 4 END,
  work_item_id
```

### Customize Number of Blockers Shown

Change the `FILTER (WHERE rn <= 5)` to show more/fewer items:

```sql
-- Show top 10 instead of top 5
FILTER (WHERE rn <= 10) AS "Top Blockers",
```

---

## API Response Format

### GET /api/release-health

```json
{
  "ok": true,
  "rows": [
    {
      "project": "Agent7",
      "release": "18.4",
      "confidencePct": 65,
      "topBlockers": "Bug 12345 - Database timeout | Task 67890 - API refactor",
      "topBlockerIds": "12345|67890",
      ...
    }
  ]
}
```

### CSV Export

The CSV export includes both columns:

```csv
project,release,...,top_blockers,top_blocker_ids,...
Agent7,18.4,...,"Bug 12345 - Database timeout | Task 67890 - API refactor","12345|67890",...
```

---

## Troubleshooting

### Issue: No blockers showing

**Cause:** View might not have data or filters are too restrictive

**Solution:**

```sql
-- Check if blockers exist in raw data
SELECT
  release,
  COUNT(*) as blocker_count
FROM tfs_workitems_analytics
WHERE is_deleted = FALSE
  AND state NOT IN ('Done', 'Removed')
  AND (severity = 'Critical' OR state = 'On Hold' OR open_dep_count > 0)
GROUP BY release;
```

### Issue: Links not working

**Cause:** `TFS_WORKITEM_URL_TEMPLATE` not set

**Solution:**

```powershell
# Check current setting
npm start
# Look for: "TFS_WORKITEM_URL_TEMPLATE not configured" in console

# Set the variable
$env:TFS_WORKITEM_URL_TEMPLATE="https://your-tfs.com/_workitems/edit/{id}"
npm start
```

### Issue: Format not parsing correctly

**Cause:** Unexpected characters in titles (e.g., " - " in the title itself)

**Solution:** The regex `^(\w+)\s+(\d+)\s+-\s+(.+)$` handles this by using greedy capture for title. If issues persist, check the data:

```sql
SELECT work_item_id, type, title
FROM tfs_workitems_analytics
WHERE title LIKE '%-%';
```

---

## Testing Checklist

- [ ] SQL view created successfully
- [ ] View returns data: `SELECT * FROM v_release_health LIMIT 5;`
- [ ] Frontend shows formatted blockers: `Type ID - Title`
- [ ] Work item IDs are clickable
- [ ] Links navigate to correct TFS/Azure DevOps page
- [ ] Works with 0 blockers (shows "-")
- [ ] Works with 1 blocker
- [ ] Works with 5+ blockers (shows top 5)
- [ ] CSV export includes both columns
- [ ] AI report generation includes blocker info

---

## Future Enhancements

1. **Hover tooltips** - Show full work item details on hover
2. **Severity indicators** - Color-code by severity (red for Critical, yellow for High)
3. **Age indicators** - Show how long items have been blocked
4. **Dependency visualization** - Link to dependency graph
5. **Blocker history** - Track blockers over time

---

## Related Files

- `create-v-release-health.sql` - SQL view definition
- `public/app.js` - Frontend display logic
- `server.js` - API endpoints (no changes needed)
- `RELEASE_RADAR_DOCUMENTATION.md` - Full feature documentation

---

## Support

For issues or questions:

1. Check the logs: `npm start` console output
2. Review database: `SELECT * FROM v_release_health WHERE release = 'YOUR_RELEASE';`
3. Check frontend console: Browser DevTools → Console tab
