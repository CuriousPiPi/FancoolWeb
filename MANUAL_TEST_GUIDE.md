# Manual Testing Guide for Local State Refactoring (F-01 to F-03)

This guide helps verify the implementation of local state management changes.

## Test Scenarios

### Test 1: Initial Load
**Expected behavior**: On first load, server provides `selected_fans` which should populate the local `selectionStore`.

1. Open browser DevTools Console
2. Navigate to the application
3. Check localStorage:
   ```javascript
   localStorage.getItem('fc_selected_v1')
   ```
4. Verify that it contains an array of objects with `model_id` and `condition_id`

### Test 2: Add Fan to Selection
**Expected behavior**: Adding a fan should update both server and local store.

1. Search for and add a fan to the chart
2. Check localStorage again:
   ```javascript
   JSON.parse(localStorage.getItem('fc_selected_v1'))
   ```
3. Verify the new fan is in the array

### Test 3: Remove Fan from Selection
**Expected behavior**: Removing a fan should:
- Remove it from the chart
- Update selectionStore
- Add entry to removedStore
- Display it in "Recently Removed" section

1. Remove a fan from the selected list
2. Check removedStore:
   ```javascript
   JSON.parse(localStorage.getItem('fc_removed_v1'))
   ```
3. Verify the removed fan appears with metadata (brand, model, res_type, res_loc, removed_at)
4. Check that it appears in the "Recently Removed" UI section

### Test 4: Server recently_removed_fans is Ignored
**Expected behavior**: Server may send `recently_removed_fans` but it should be ignored.

1. Open DevTools Network tab
2. Perform an action that triggers `/api/state` or similar endpoint
3. Check response - it may include `recently_removed_fans`
4. Verify that the "Recently Removed" section only shows items from localStorage (`fc_removed_v1`)
5. Verify in console:
   ```javascript
   // Should only show items from local store, not from server
   window.__APP.localStores.removedStore.list()
   ```

### Test 5: Circular Buffer (MAX=30)
**Expected behavior**: The removedStore should maintain at most 30 items.

1. Remove more than 30 fans (or manually test):
   ```javascript
   const removedStore = window.__APP.localStores.removedStore;
   for (let i = 0; i < 35; i++) {
     removedStore.push({
       key: `test_${i}_0`,
       model_id: i,
       condition_id: 0,
       brand: 'TestBrand',
       model: 'TestModel',
       res_type: 'TestType',
       res_loc: 'TestLoc'
     });
   }
   console.log(removedStore.list().length); // Should be 30
   ```

### Test 6: Restore Fan
**Expected behavior**: Restoring a fan from "Recently Removed" should:
- Add it back to selected list
- Remove it from removedStore

1. Click restore button on a recently removed fan
2. Verify it appears in the chart
3. Check removedStore - the item should be gone:
   ```javascript
   JSON.parse(localStorage.getItem('fc_removed_v1'))
   ```

### Test 7: Clear All
**Expected behavior**: Clearing all selected fans should add all of them to removedStore.

1. Have several fans selected
2. Click "Clear All" button
3. Check that all fans appear in "Recently Removed"
4. Verify removedStore contains them:
   ```javascript
   window.__APP.localStores.removedStore.list()
   ```

### Test 8: Persistence Across Page Reloads
**Expected behavior**: Local stores should persist across page reloads.

1. Add several fans
2. Remove some fans
3. Note the counts in selected and removed sections
4. Reload the page (F5)
5. Verify:
   - Selected fans list matches (from server or local)
   - Recently removed list is populated from local store
   - Check console:
     ```javascript
     window.__APP.localStores.selectionStore.list()
     window.__APP.localStores.removedStore.list()
     ```

## Verification Commands

Run these in the browser console to inspect the state:

```javascript
// Check all stores
console.log('Selection:', window.__APP.localStores.selectionStore.list());
console.log('Removed:', window.__APP.localStores.removedStore.list());
console.log('ShareMeta:', window.__APP.localStores.shareMetaStore.get());
console.log('Likes:', window.__APP.localStores.likeStore.list());

// Check localStorage directly
console.log('fc_selected_v1:', localStorage.getItem('fc_selected_v1'));
console.log('fc_removed_v1:', localStorage.getItem('fc_removed_v1'));

// Check if removedStore onChange is working
let changeCount = 0;
window.__APP.localStores.removedStore.onChange(() => {
  changeCount++;
  console.log('Removed store changed!', changeCount);
});
```

## Expected Console Output

On successful initialization, you should see:
```
[LocalStores] Initialized successfully.
[Fancool] main.js initializing.
...
```

No errors related to localStorage or localStores should appear.

## Troubleshooting

### If stores are not initialized:
1. Check that `localStores.js` is loaded before `state-ui.js`
2. Verify in console: `window.__APP.localStores` should exist

### If recently removed doesn't show:
1. Check: `window.__APP.localStores.removedStore.list()`
2. Verify onChange subscription is active
3. Check for errors in console

### If localStorage is not working:
1. Check browser's localStorage is enabled
2. Check for quota exceeded errors
3. Try clearing localStorage and reloading: `localStorage.clear()`
