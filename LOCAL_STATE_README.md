# Local State Refactoring - Quick Reference

## What Was Done

Implemented tasks **F-01**, **F-02**, and **F-03** from `LOCAL_STATE_OVERVIEW_CN.md`:

1. ✅ Removed server-side injection logic for `recently_removed_fans`
2. ✅ Created `localStores.js` module for client-side state management
3. ✅ Integrated local stores with `state-ui.js` for diff-based synchronization

## Files Changed

```
6 files changed, 1302 insertions(+), 19 deletions(-)

New Files:
  + app/static/js/localStores.js    (414 lines) - Core local storage module
  + IMPLEMENTATION_SUMMARY.md       (330 lines) - Technical documentation
  + MANUAL_TEST_GUIDE.md            (163 lines) - Testing instructions  
  + ARCHITECTURE.md                 (295 lines) - Visual diagrams

Modified:
  * app/static/js/state-ui.js       (+99 lines) - Local stores integration
  * app/templates/fancoolindex.html (+1 line)   - Load localStores.js
```

## Quick Start

### For Developers

**Check if it works:**
```javascript
// Open browser console
window.__APP.localStores  // Should show object with stores

// Check current state
window.__APP.localStores.selectionStore.list()  // Current selections
window.__APP.localStores.removedStore.list()    // Recent removals
```

**Verify localStorage:**
```javascript
localStorage.getItem('fc_selected_v1')  // Selection store
localStorage.getItem('fc_removed_v1')   // Removed store (MAX=30)
```

### For Testers

Run through scenarios in `MANUAL_TEST_GUIDE.md`:
1. Add fan → Check selectionStore
2. Remove fan → Check removedStore
3. Restore fan → Verify it's back
4. Reload page → Check persistence

## Key Concepts

### Local Stores
- **selectionStore**: Tracks currently selected fans (model_id + condition_id only)
- **removedStore**: Tracks recently removed fans (up to 30, with full metadata)
- **shareMetaStore**: Placeholder for share preferences
- **likeStore**: In-memory cache of liked items
- **colorStore**: Placeholder for color assignments

### How It Works

**Before:**
```
Server sends: selected_fans + recently_removed_fans
Client uses:  Both lists directly
```

**After:**
```
Server sends: selected_fans + recently_removed_fans (ignored)
Client:       1. Computes diff vs lastSelectedFans
              2. Removed items → removedStore (localStorage)
              3. Added items → selectionStore (localStorage)
              4. UI rebuilt from local stores
```

### Diff Algorithm
```javascript
incoming = ['1_2', '3_4']       // From server
last = ['1_2', '2_3', '3_4']    // Stored locally

diff:
  added = []                     // Nothing new
  removed = ['2_3']              // Missing from incoming
  
→ Push '2_3' to removedStore with metadata
```

## Important Details

### Circular Buffer (removedStore)
- Maximum 30 items
- Newest first (push to front)
- Oldest automatically dropped
- Duplicates removed

### Metadata Preservation
Removed items store:
```javascript
{
  key: "123_456",           // model_id_condition_id
  model_id: 123,
  condition_id: 456,
  brand: "Noctua",          // Preserved from lastSelectedFans
  model: "NH-D15",
  res_type: "满载",
  res_loc: "全部",
  removed_at: "2024-01-01T12:00:00.000Z"
}
```

### Server Compatibility
- Server can still send `recently_removed_fans` (harmless, ignored)
- No server changes required
- All existing APIs work unchanged
- `patchRemovedFans()` always returns `skipped: true`

## Documentation Map

| File | Purpose |
|------|---------|
| **IMPLEMENTATION_SUMMARY.md** | Complete technical walkthrough with code examples |
| **MANUAL_TEST_GUIDE.md** | Step-by-step testing scenarios |
| **ARCHITECTURE.md** | Visual diagrams and data flow charts |
| **THIS FILE** | Quick reference and overview |

## Debugging

### Common Issues

**Store not initialized:**
```javascript
// Check initialization
console.log(window.__APP.localStores);  // Should be object, not undefined

// Check script load order (should see this in console):
[LocalStores] Initialized successfully.
```

**localStorage not working:**
```javascript
// Check if localStorage is available
typeof localStorage  // Should be 'object'

// Check quota
localStorage.setItem('test', 'test')  // Should not throw

// Clear if needed
localStorage.removeItem('fc_selected_v1')
localStorage.removeItem('fc_removed_v1')
```

**Removed items not showing:**
```javascript
// Check store
window.__APP.localStores.removedStore.list()  // Should return array

// Check onChange subscription
// Should see in console when you remove an item:
[removedStore] push() called

// Manually rebuild UI
if (window.__APP.stateUI && window.__APP.stateUI.rebuildRemovedFansFromStore) {
  window.__APP.stateUI.rebuildRemovedFansFromStore()
}
```

## Testing

### Automated
```bash
# Run syntax check
node /tmp/test_js_syntax.js

# Run unit tests
node /tmp/test_localStores_node.js
```

### Manual
See `MANUAL_TEST_GUIDE.md` for 8 detailed test scenarios.

## Next Steps (Future Work)

Tasks **F-04** through **F-15** from `LOCAL_STATE_OVERVIEW_CN.md`:
- F-04: Read initial selection from localStorage
- F-05: Schema version control
- F-06: Pure client-side operations (no API calls)
- F-07+: Additional enhancements

## Related Tasks

- ✅ F-01: Remove server recently_removed_fans injection
- ✅ F-02: Local removedStore with circular buffer
- ✅ F-03: Modular localStores.js

## Support

Questions? Check:
1. `IMPLEMENTATION_SUMMARY.md` - Technical details
2. `ARCHITECTURE.md` - Visual explanations  
3. `MANUAL_TEST_GUIDE.md` - Testing help
4. Browser console for error messages
5. `LOCAL_STATE_OVERVIEW_CN.md` - Original requirements
