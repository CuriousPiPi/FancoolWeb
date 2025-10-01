# Architecture Diagram: Local State Management

## Component Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌────────────────────────────────────────────────────────┐    │
│  │             fancoolindex.html (Template)               │    │
│  └────────────────────────────────────────────────────────┘    │
│                              │                                   │
│                              │ Loads Scripts                     │
│                              ▼                                   │
│  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌───────────┐  │
│  │ core.js  │→│localStores.js│→│ color.js │→│ chart.js  │  │
│  └──────────┘  └──────────────┘  └──────────┘  └───────────┘  │
│                       │                                          │
│                       ▼                                          │
│  ┌──────────────┐  ┌──────────┐  ┌─────────┐                   │
│  │ state-ui.js  │→│ layout.js│→│ main.js │                   │
│  └──────────────┘  └──────────┘  └─────────┘                   │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

## localStores.js Module Structure

```
┌──────────────────────────────────────────────────────────────┐
│              window.__APP.localStores                         │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  makeKey(model_id, condition_id) → "mid_cid"                │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  selectionStore                                      │   │
│  │  ├─ list()                                           │   │
│  │  ├─ has(mid, cid)                                    │   │
│  │  ├─ add({model_id, condition_id, meta?})            │   │
│  │  ├─ remove(mid, cid)                                 │   │
│  │  ├─ replace(newList)                                 │   │
│  │  ├─ clear()                                          │   │
│  │  └─ onChange(callback)                               │   │
│  │                                                       │   │
│  │  Storage: localStorage['fc_selected_v1']            │   │
│  │  Format: [{model_id, condition_id}]                 │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  removedStore                                        │   │
│  │  ├─ push(entry)                                      │   │
│  │  ├─ removeByKey(key)                                 │   │
│  │  ├─ list()                                           │   │
│  │  └─ onChange(callback)                               │   │
│  │                                                       │   │
│  │  Storage: localStorage['fc_removed_v1']             │   │
│  │  Format: [{key, model_id, condition_id, brand,      │   │
│  │            model, res_type, res_loc, removed_at}]   │   │
│  │  Max: 30 items (circular buffer)                    │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  shareMetaStore (skeleton)                           │   │
│  │  ├─ get()                                            │   │
│  │  ├─ save(partial)                                    │   │
│  │  └─ onChange(callback)                               │   │
│  │                                                       │   │
│  │  Storage: localStorage['fc_share_meta_v1']          │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  likeStore (in-memory)                               │   │
│  │  ├─ set(keysArray)                                   │   │
│  │  ├─ has(key)                                         │   │
│  │  ├─ add(key)                                         │   │
│  │  ├─ remove(key)                                      │   │
│  │  └─ list()                                           │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  colorStore (skeleton)                               │   │
│  │  ├─ getIndex(key)                                    │   │
│  │  ├─ ensure(keysArray)                                │   │
│  │  └─ clear()                                          │   │
│  │                                                       │   │
│  │  Storage: localStorage['fc_color_map_v1']           │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

## Data Flow: Remove Fan Operation

```
┌─────────────┐
│    User     │
│  clicks     │
│  "Remove"   │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────────────────┐
│  state-ui.js: Event Listener                        │
│  - Captures click on .js-remove-fan                 │
│  - Gets fan_key from dataset                        │
└──────┬──────────────────────────────────────────────┘
       │
       │ apiPost('/api/remove_fan', {fan_key})
       ▼
┌─────────────────────────────────────────────────────┐
│  Flask Server                                        │
│  - Removes fan from session['selected_fans']        │
│  - (May add to session['recently_removed_fans'])   │
│  - Returns: {selected_fans: [...]}                  │
└──────┬──────────────────────────────────────────────┘
       │
       │ Response data
       ▼
┌─────────────────────────────────────────────────────┐
│  state-ui.js: processState(data)                    │
│  - Calls patchSelectedFans(data)                    │
└──────┬──────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│  state-ui.js: patchSelectedFans()                             │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 1. Extract incoming fans and keys                      │  │
│  │ 2. Compare with lastSelectedFans                       │  │
│  │ 3. Compute diff: added=[], removed=[removed_key]       │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 4. For each removed key:                               │  │
│  │    - Look up fan metadata in lastFansMap               │  │
│  │    - Call removedStore.push({                          │  │
│  │        key, model_id, condition_id,                    │  │
│  │        brand, model, res_type, res_loc,                │  │
│  │        removed_at: new Date().toISOString()            │  │
│  │      })                                                 │  │
│  └────────────────────────────────────────────────────────┘  │
│                    │                                           │
│                    ▼                                           │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ removedStore.push():                                   │  │
│  │  - Remove duplicates                                   │  │
│  │  - Add to front of array                               │  │
│  │  - Trim to MAX=30                                      │  │
│  │  - Save to localStorage['fc_removed_v1']              │  │
│  │  - Notify onChange listeners                           │  │
│  └────────────────────────────────────────────────────────┘  │
│                    │                                           │
│                    ▼                                           │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ onChange callback triggers:                            │  │
│  │  rebuildRemovedFansFromStore()                         │  │
│  └────────────────────────────────────────────────────────┘  │
│                    │                                           │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 5. Update selectionStore:                              │  │
│  │    - Build currentSelection from incoming fans         │  │
│  │    - Call selectionStore.replace(currentSelection)     │  │
│  └────────────────────────────────────────────────────────┘  │
│                    │                                           │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 6. Update UI:                                          │  │
│  │    - rebuildSelectedFans(fans)                         │  │
│  │    - Update lastSelectedFans = fans.slice()            │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────┐
│  rebuildRemovedFansFromStore()                       │
│  - Read list = removedStore.list()                  │
│  - Call rebuildRemovedFans(list)                    │
│  - Rebuild HTML for "Recently Removed" section      │
│  - User sees removed fan in the list                │
└─────────────────────────────────────────────────────┘
```

## State Synchronization

```
┌─────────────────────────────────────────────────────────┐
│                    Initial Load                          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Server                  Client                          │
│  ┌─────────┐           ┌──────────────┐                │
│  │ Session │  ────→    │ localStorage │                │
│  │         │ selected  │              │                │
│  │selected_│   fans    │ fc_selected  │                │
│  │  fans   │           │     _v1      │                │
│  └─────────┘           └──────────────┘                │
│                                                          │
│  ┌─────────┐           ┌──────────────┐                │
│  │ Session │    X      │ localStorage │                │
│  │recently_│ (ignored) │              │                │
│  │ removed │           │ fc_removed   │                │
│  │  fans   │           │     _v1      │                │
│  └─────────┘           └──────────────┘                │
│                                                          │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│             Subsequent Operations                        │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Server                  Client                          │
│  ┌─────────┐           ┌──────────────┐                │
│  │ Session │  ←────→   │ localStorage │                │
│  │         │  sync via │              │                │
│  │selected_│  API calls│ fc_selected  │                │
│  │  fans   │  + diff   │     _v1      │                │
│  └─────────┘           └──────────────┘                │
│                                ↓                         │
│                          Diff detects                    │
│                           removals                       │
│                                ↓                         │
│  (not used)            ┌──────────────┐                │
│                        │ localStorage │                │
│                        │              │                │
│                        │ fc_removed   │                │
│                        │     _v1      │                │
│                        └──────────────┘                │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

## localStorage Keys

```
┌────────────────────────┬──────────────────────────────────────┐
│ Key                    │ Content                              │
├────────────────────────┼──────────────────────────────────────┤
│ fc_selected_v1         │ [{model_id, condition_id}]           │
├────────────────────────┼──────────────────────────────────────┤
│ fc_removed_v1          │ [{key, model_id, condition_id,       │
│                        │   brand, model, res_type, res_loc,   │
│                        │   removed_at}] (max 30)              │
├────────────────────────┼──────────────────────────────────────┤
│ fc_share_meta_v1       │ {show_raw_curves, ...} (skeleton)    │
├────────────────────────┼──────────────────────────────────────┤
│ fc_color_map_v1        │ {"mid_cid": colorIndex} (skeleton)   │
└────────────────────────┴──────────────────────────────────────┘
```

## Comparison: Before vs After

```
┌─────────────────────────────────────────────────────────────┐
│                       BEFORE                                 │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Server Response (every API call):                          │
│  {                                                           │
│    selected_fans: [...],      ← Used                        │
│    recently_removed_fans: [...], ← Used                     │
│    chart_data: {...},                                       │
│    share_meta: {...}                                        │
│  }                                                           │
│                                                              │
│  Frontend:                                                   │
│  - Rebuilds selected list from server                       │
│  - Rebuilds removed list from server                        │
│  - No persistence                                           │
│  - Server controls all state                                │
│                                                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                       AFTER                                  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Server Response:                                            │
│  {                                                           │
│    selected_fans: [...],      ← Used for diff & display    │
│    recently_removed_fans: [...], ← IGNORED                  │
│    chart_data: {...},                                       │
│    share_meta: {...}                                        │
│  }                                                           │
│                                                              │
│  Frontend:                                                   │
│  - Computes diff vs lastSelectedFans                        │
│  - Updates selectionStore (localStorage)                    │
│  - Pushes removed items to removedStore (localStorage)      │
│  - Rebuilds removed list from LOCAL store only              │
│  - Persistence across reloads                               │
│  - Client controls removed list                             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```
