"""Operate Chrome's own extension action, with a fresh accessibility lookup."""
import json
import sys
import time
import subprocess
import pyatspi


def nodes(root, depth=0, include_web=False):
    if depth > 35:
        return
    try:
        if not include_web and root.getRoleName() in ('document web', 'document frame'):
            return
        yield root
        for child in root:
            yield from nodes(child, depth + 1, include_web)
    except Exception:
        return


def visible(node):
    state = node.getState()
    return state.contains(pyatspi.STATE_SHOWING) and state.contains(pyatspi.STATE_VISIBLE)


def document_for(url):
    found = {}
    for node in nodes(pyatspi.Registry.getDesktop(0), include_web=True):
        if node.getRoleName() not in ('document web', 'document frame') or not visible(node):
            continue
        attrs = dict(a.split(':', 1) for a in node.queryDocument().getAttributes() if ':' in a)
        if attrs.get('URI') == url:
            # Chrome can expose the same accessible through two branches.
            found[hash(node)] = node
    if len(found) != 1:
        raise RuntimeError('Native document is missing or ambiguous')
    return next(iter(found.values()))


def describe(node, path):
    attrs = dict(a.split(':', 1) for a in node.getAttributes() if ':' in a)
    box = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
    role = node.getRoleName()
    protected = role == 'password text' or attrs.get('text-input-type') == 'password'
    return {'path': path, 'name': '' if protected else node.name[:500], 'role': role,
            'placeholder': '' if protected else attrs.get('placeholder', '')[:200],
            'protected': protected, 'editable': node.getState().contains(pyatspi.STATE_EDITABLE),
            'enabled': node.getState().contains(pyatspi.STATE_ENABLED),
            'bounds': [box.x, box.y, box.width, box.height]}


def surface_rows(root, path=None, depth=0):
    path = [] if path is None else path
    if depth > 35:
        return
    if visible(root):
        row = describe(root, path)
        if row['name'] or row['editable'] or row['protected']:
            yield row
    for index, child in enumerate(root):
        yield from surface_rows(child, path + [index], depth + 1)


def surface(input):
    root = document_for(input['url'])
    if input['operation'] == 'read':
        return {'url': input['url'], 'nodes': list(surface_rows(root))[:400]}
    expected = input['node']
    node = root
    for index in expected['path']:
        node = node[index]
    if not visible(node) or describe(node, expected['path']) != expected:
        raise RuntimeError('Native control changed; read the popup again')
    x, y, width, height = expected['bounds']
    if width <= 1 or height <= 1 or not expected['enabled']:
        raise RuntimeError('Native control cannot be driven')
    if input['operation'] == 'fill' and not expected['editable']:
        raise RuntimeError('Native control is not editable')
    subprocess.run(['xdotool', 'mousemove', '--sync', str(x + width // 2), str(y + height // 2), 'click', '1'], check=True, timeout=3)
    if input['operation'] == 'fill':
        subprocess.run(['xdotool', 'key', '--clearmodifiers', 'ctrl+a'], check=True, timeout=3)
        # Neither command arguments nor stdout ever contain credentials.
        subprocess.run(['xdotool', 'type', '--clearmodifiers', '--file', '-'],
                       input=input['value'], text=True, check=True, timeout=5)
    return {'acted': True, 'operation': input['operation'], 'via': 'native-input'}


def redactions(secrets):
    boxes = set()
    for node in nodes(pyatspi.Registry.getDesktop(0), include_web=True):
        if not visible(node):
            continue
        sensitive = node.getState().contains(pyatspi.STATE_EDITABLE) or node.getRoleName() == 'password text'
        if not sensitive and secrets:
            text = node.name or ''
            try:
                text += node.queryText().getText(0, -1)
            except Exception:
                pass
            sensitive = any(secret and secret in text for secret in secrets)
        if sensitive:
            box = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
            if box.width > 0 and box.height > 0:
                boxes.add((box.x - 8, box.y - 8, box.x + box.width + 8, box.y + box.height + 8))
    return list(boxes)


def click_named(name, include_web=False):
    names = name if isinstance(name, list) else [name]
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        for node in nodes(pyatspi.Registry.getDesktop(0), include_web=include_web):
            try:
                if node.name not in names or not visible(node) or node.getRoleName() not in ('push button', 'menu item', 'label', 'static', 'check box'):
                    continue
                # AT-SPI's default extension action may inspect a popup. A
                # physical left click grants the same invocation as a user;
                # coordinates come from this fresh, named native control.
                box = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
                if box.width <= 0 or box.height <= 0:
                    continue
                subprocess.run(['xdotool', 'mousemove', '--sync', str(box.x + box.width // 2), str(box.y + box.height // 2), 'click', '1'], check=True, timeout=3)
                return
            except Exception:
                continue
        time.sleep(0.1)
    raise RuntimeError('Native control unavailable: ' + str(names))


if sys.argv[1] == 'surface':
    print(json.dumps(surface(json.load(sys.stdin))))
elif sys.argv[1] == 'redactions':
    print(json.dumps(redactions(json.load(sys.stdin))))
elif sys.argv[1] == 'tree':
    print(json.dumps([{'name': n.name, 'role': n.getRoleName()}
                      for n in nodes(pyatspi.Registry.getDesktop(0))
                      if n.name and visible(n)]))
elif sys.argv[1] == 'popup':
    # Chrome exposes the installed extension by name in its native menu.
    if not any(n.name == sys.argv[2] and visible(n) and n.getRoleName() == 'push button' for n in nodes(pyatspi.Registry.getDesktop(0))):
        click_named(['Extensions', 'Extensions allowed on this site. Select to open menu'])
    click_named(sys.argv[2])
    print(json.dumps({'invoked': True, 'via': 'native-action'}))

elif sys.argv[1] == 'click':
    click_named(sys.argv[2])
    print(json.dumps({'clicked': sys.argv[2]}))

elif sys.argv[1] == 'popup-control':
    click_named(sys.argv[2], include_web=True)
    print(json.dumps({'clicked': sys.argv[2], 'via': 'native-input'}))
elif sys.argv[1] == 'tree-web':
    print(json.dumps([{'name': n.name, 'role': n.getRoleName()} for n in nodes(pyatspi.Registry.getDesktop(0), include_web=True) if n.name and visible(n)]))
