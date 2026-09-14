"""Mask glyphs only when their complete geometry is available; otherwise mask the node."""


def padded(box):
    x, y, width, height = box
    return (x - 8, y - 8, x + width + 8, y + height + 8)


def secret_boxes(name, text, character_box, component, secrets, editable=False):
    if editable:
        return [padded(component)]
    matching = [secret for secret in secrets if secret and (secret in name or secret in text)]
    if not matching:
        return []
    boxes = []
    try:
        for secret in matching:
            if secret not in text or name.count(secret) > text.count(secret):
                raise ValueError('Text geometry does not cover the accessible name')
            offset = text.find(secret)
            while offset >= 0:
                glyphs = []
                for index in range(offset, offset + len(secret)):
                    if text[index].isspace():
                        continue
                    box = character_box(index)
                    if len(box) != 4 or box[2] <= 0 or box[3] <= 0:
                        raise ValueError('Secret glyph geometry unavailable')
                    glyphs.append(box)
                if not glyphs:
                    raise ValueError('Secret glyph geometry empty')
                left, top = min(b[0] for b in glyphs), min(b[1] for b in glyphs)
                right, bottom = max(b[0] + b[2] for b in glyphs), max(b[1] + b[3] for b in glyphs)
                boxes.append(padded((left, top, right - left, bottom - top)))
                offset = text.find(secret, offset + len(secret))
        return boxes
    except Exception:
        return [padded(component)]
