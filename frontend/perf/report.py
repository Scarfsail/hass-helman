import json, sys, glob, os

def rate(v, secs):
    return v / secs if secs else 0

for path in sorted(sys.argv[1:] or glob.glob('results/*.json')):
    r = json.load(open(path))
    last = r['samples'][-1]
    snap = last['snap']
    secs = last['atSec']
    print("=" * 100)
    print(f"{r['label']}  view={r['view']} mode={r['mode']}  window={secs}s")
    print(f"heap: base {r['baseHeap']/1e6:.1f}MB -> end {r['endHeap']/1e6:.1f}MB (both after forced GC)   "
          f"delta {(r['endHeap']-r['baseHeap'])/1e6:+.1f}MB")
    print(f"nodes: {r['baseMetrics']['Nodes']} -> {r['endMetrics']['Nodes']}   "
          f"listeners: {r['baseMetrics']['JSEventListeners']} -> {r['endMetrics']['JSEventListeners']}")
    print(f"custom elements: {r['baseInstances'].get('__totalCustomElements')} -> {r['endInstances'].get('__totalCustomElements')}")
    sc = snap.get('stateChanges', {})
    print(f"hass state-change frames: {sc.get('messages',0)} ({rate(sc.get('messages',0),secs):.1f}/s), "
          f"entities touched: {sc.get('entities',0)} ({rate(sc.get('entities',0),secs):.1f}/s)")
    print(f"script time (CDP ScriptDuration): {r['baseMetrics']['ScriptDuration']:.1f}s -> {r['endMetrics']['ScriptDuration']:.1f}s "
          f"= {r['endMetrics']['ScriptDuration']-r['baseMetrics']['ScriptDuration']:.1f}s of JS in {secs}s "
          f"({100*(r['endMetrics']['ScriptDuration']-r['baseMetrics']['ScriptDuration'])/secs:.1f}% of one core)")
    print()
    print(f"{'component':38} {'hass sets':>10} {'updates':>9} {'upd/s':>7} {'update ms':>10} {'%cpu':>6} {'max ms':>7}")
    for tag, v in sorted(snap['el'].items(), key=lambda kv: -kv[1]['updateMs']):
        if not v['updates']:
            continue
        print(f"{tag:38} {snap['hassSets'].get(tag,0):>10} {v['updates']:>9} {rate(v['updates'],secs):>7.1f} "
              f"{v['updateMs']:>10.0f} {100*v['updateMs']/1000/secs:>5.2f}% {v['maxUpdateMs']:>7.1f}")
    total = sum(v['updateMs'] for v in snap['el'].values())
    print(f"{'TOTAL helman components':38} {'':>10} {'':>9} {'':>7} {total:>10.0f} {100*total/1000/secs:>5.2f}%")
    print()
    print("top change sets (which properties triggered each update):")
    for k, v in sorted(snap.get('changeSets', {}).items(), key=lambda kv: -kv[1])[:14]:
        print(f"  {v:>6} ({rate(v,secs):>5.1f}/s)  {k[:110]}")
    if snap.get('setDuringRender'):
        print("properties set DURING render (swallowed by Lit, so silently lost):")
        for k, v in sorted(snap['setDuringRender'].items(), key=lambda kv: -kv[1])[:10]:
            print(f"  {v:>6}  {k}")
    print()
    print("websocket messages sent by the page:")
    for k, v in sorted(snap['ws']['sentByType'].items(), key=lambda kv: -kv[1]):
        print(f"  {v:>6} ({60*rate(v,secs):>6.1f}/min)  {k}")
    print("helman events received:", snap['ws']['recvEventTypes'])
    print(f"ws bytes: sent {snap['ws']['sentBytes']/1e3:.0f}kB  recv {snap['ws']['recvBytes']/1e6:.2f}MB "
          f"({snap['ws']['recvBytes']/1e3/secs:.1f} kB/s)")
    if snap.get('fn'):
        print()
        print("inspector internals:")
        for k, v in sorted(snap['fn'].items(), key=lambda kv: -kv[1]['ms'])[:20]:
            print(f"  {k:52} calls={v['calls']:>7} ({rate(v['calls'],secs):>5.1f}/s) ms={v['ms']:>8.0f} max={v['maxMs']:>6.1f}")
    print()
    print("heap trace (MB, no GC between samples):",
          " ".join(f"{s['metrics']['JSHeapUsedSize']/1e6:.0f}" for s in r['samples']))
    print("nodes trace:", " ".join(str(s['metrics']['Nodes']) for s in r['samples']))
    print("listeners trace:", " ".join(str(s['metrics']['JSEventListeners']) for s in r['samples']))
    print()
