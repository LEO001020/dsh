"""IPY-13 step 2, corrected: send execute_request with metadata manually.

V3 section M2's investigation order:
  1. can execute_request metadata / kernel parent headers expose a DSH cell id to a hook?
  2. do pre_run_cell / post_run_cell or kernel execution hooks work?
  3. only if necessary, a thin Python stream proxy.
And it forbids exec() wrapping (breaks top-level await, magics, traceback
locations, displayhook).

This measures (1) and (2) plus the semantic traps that must survive.
"""
import json, time
from jupyter_client.manager import KernelManager

km = KernelManager(kernel_name='python3')
km.start_kernel(stdout=open(r'D:/DSH/work/ipy13-exp/k3.out','wb'),
                stderr=open(r'D:/DSH/work/ipy13-exp/k3.err','wb'))
kc = km.client(); kc.start_channels(); kc.wait_for_ready(timeout=60)

def run(code, metadata=None, timeout=30):
    content = {'code': code, 'silent': False, 'store_history': True,
               'user_expressions': {}, 'allow_stdin': False, 'stop_on_error': True}
    msg = kc.session.msg('execute_request', content, metadata=dict(metadata or {}))
    kc.shell_channel.send(msg)
    msg_id = msg['header']['msg_id']
    out = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        try: m = kc.get_iopub_msg(timeout=0.5)
        except Exception: continue
        if m.get('parent_header', {}).get('msg_id') != msg_id: continue
        mt = m.get('msg_type')
        if mt == 'stream':
            out.append(('stream', m['content'].get('name'), m['content'].get('text')))
        elif mt == 'execute_result':
            out.append(('result', m['content'].get('data', {}).get('text/plain')))
        elif mt == 'error':
            out.append(('error', m['content'].get('ename'), m['content'].get('evalue')))
        if mt == 'status' and m['content'].get('execution_state') == 'idle':
            break
    return out

R = {}
R['setup'] = run('''
import contextvars
_dsh_cell = contextvars.ContextVar('dsh_cell', default=None)
_seen = []
from IPython import get_ipython
_ip = get_ipython()
def _pre(info):
    rec = {'info_fields': sorted(vars(info).keys()) if hasattr(info,'__dict__') else []}
    try:
        k = _ip.kernel
        ph = getattr(k, '_parent_header', None) or {}
        rec['parent_meta'] = ph.get('metadata')
        rec['parent_msg_id'] = ph.get('msg_id')
    except Exception as e:
        rec['err'] = repr(e)
    _seen.append(rec)
_ip.events.register('pre_run_cell', _pre)
print('SETUP_OK')
''')

# (1) Does metadata reach pre_run_cell, and can it be turned into a ContextVar?
R['meta_to_ctxvar'] = run(
    "_dsh_cell.set((_seen[-1].get('parent_meta') or {}).get('dsh_cell_id'))\n"
    "print('META_SEEN', _seen[-1].get('parent_meta'))\n"
    "print('CTXVAR_FROM_META', _dsh_cell.get())\n",
    metadata={'dsh_cell_id': 'CELL-A'})

# (2) Same-cell visibility of the ContextVar
R['same_cell'] = run("print('SAME_CELL', _dsh_cell.get())", metadata={'dsh_cell_id': 'CELL-B'})

# (3) Plain thread: does it inherit the ContextVar?
R['plain_thread'] = run(
    "import threading\nres={}\n"
    "t=threading.Thread(target=lambda: res.__setitem__('v', _dsh_cell.get()))\n"
    "t.start(); t.join()\n"
    "print('PLAIN_THREAD', res['v'])\n", metadata={'dsh_cell_id': 'CELL-C'})

# (4) Empty/fresh context must NOT see it (the undecidable case)
R['fresh_context'] = run(
    "import contextvars\nres={}\n"
    "contextvars.Context().run(lambda: res.__setitem__('v', _dsh_cell.get()))\n"
    "print('FRESH_CONTEXT', res['v'])\n", metadata={'dsh_cell_id': 'CELL-D'})

# (5) No metadata at all -> must be None (no fallback to 'latest cell')
R['no_metadata'] = run("print('NO_META', _dsh_cell.get())")

# (6) Semantic traps that must survive any hook.
R['top_level_await'] = run("import asyncio\nawait asyncio.sleep(0.01)\nprint('AWAIT_OK')")
R['magic'] = run("%who\nprint('MAGIC_OK')")
R['traceback'] = run("def f():\n    raise ValueError('boom')\nf()")
R['displayhook'] = run("1 + 1")

print(json.dumps(R, indent=1, default=str))
kc.stop_channels(); km.shutdown_kernel(now=True)
